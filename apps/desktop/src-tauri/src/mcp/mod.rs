//! In-app MCP server (RAD-209): Streamable HTTP at `/mcp` on 127.0.0.1, built on `rmcp`, the
//! official MCP Rust SDK, and sharing the app's SQLite store.
//!
//! - Listens on loopback only. Before anything else (and before any database lookup) the
//!   `Host` header must be exactly a loopback name plus our port (`127.0.0.1`, `localhost` or
//!   `[::1]`), and any `Origin` header is refused: this is the DNS-rebinding guard.
//! - Every request carries `Authorization: Bearer <agent token>` (RAD-205). Every auth failure
//!   (missing, malformed, unknown or revoked token) gets the same 401 body and is held to the
//!   same minimum response time, so responses don't reveal whether a token exists. Failed
//!   attempts are throttled per client and globally; valid tokens are rate limited per token.
//! - Each tool checks its scope and every call is written to `audit_events`.
//! - Agents may read, comment and suggest. Accepting or rejecting a suggestion is human-only
//!   and is never exposed as an MCP tool.

mod tools;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use rmcp::transport::streamable_http_server::session::never::NeverSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};

use crate::storage::Store;
pub use tools::CoauthorMcp;

pub const DEFAULT_HOST: &str = "127.0.0.1";
pub const DEFAULT_PORT: u16 = 7337;
/// Requests allowed per token per window.
pub const RATE_LIMIT: u32 = 120;
pub const RATE_WINDOW: Duration = Duration::from_secs(60);

/// Server limits. `port` is the port clients must name in `Host`.
#[derive(Clone, Debug)]
pub struct McpConfig {
    pub port: u16,
    /// Requests per valid token per [`RATE_WINDOW`].
    pub rate_limit: u32,
    /// Failed auth attempts per client address per window before it is throttled.
    pub auth_failures_per_client: u32,
    /// Failed auth attempts across all clients per window before everyone is throttled.
    pub auth_failures_global: u32,
    /// Every auth failure takes at least this long, whatever the reason.
    pub auth_failure_floor: Duration,
}

impl McpConfig {
    pub fn new(port: u16) -> Self {
        Self {
            port,
            rate_limit: RATE_LIMIT,
            auth_failures_per_client: 10,
            auth_failures_global: 50,
            auth_failure_floor: Duration::from_millis(250),
        }
    }
}

/// Counters for tests and diagnostics.
#[derive(Default, Debug)]
pub struct GateStats {
    /// Token lookups that reached the database.
    pub auth_lookups: AtomicU64,
}

type Window = (Instant, u32);

fn bump(w: &mut Window, now: Instant) -> u32 {
    if now.duration_since(w.0) >= RATE_WINDOW {
        *w = (now, 0);
    }
    w.1 += 1;
    w.1
}

fn current(w: &Window, now: Instant) -> u32 {
    if now.duration_since(w.0) >= RATE_WINDOW {
        0
    } else {
        w.1
    }
}

#[derive(Default)]
struct Failures {
    per_client: HashMap<String, Window>,
    global: Option<Window>,
}

#[derive(Clone)]
struct Gate {
    store: Store,
    cfg: McpConfig,
    allowed_hosts: Arc<Vec<String>>,
    per_token: Arc<Mutex<HashMap<String, Window>>>,
    failures: Arc<Mutex<Failures>>,
    stats: Arc<GateStats>,
}

impl Gate {
    fn allow_token(&self, token_id: &str) -> bool {
        let mut m = self.per_token.lock().expect("limiter poisoned");
        let now = Instant::now();
        let w = m.entry(token_id.to_string()).or_insert((now, 0));
        bump(w, now) <= self.cfg.rate_limit
    }

    fn throttled(&self, client: &str) -> bool {
        let f = self.failures.lock().expect("limiter poisoned");
        let now = Instant::now();
        let c = f.per_client.get(client).map_or(0, |w| current(w, now));
        let g = f.global.as_ref().map_or(0, |w| current(w, now));
        c >= self.cfg.auth_failures_per_client || g >= self.cfg.auth_failures_global
    }

    fn record_failure(&self, client: &str) {
        let mut f = self.failures.lock().expect("limiter poisoned");
        let now = Instant::now();
        f.per_client
            .retain(|_, w| now.duration_since(w.0) < RATE_WINDOW);
        bump(
            f.per_client.entry(client.to_string()).or_insert((now, 0)),
            now,
        );
        bump(f.global.get_or_insert((now, 0)), now);
    }
}

fn forbidden() -> Response {
    (StatusCode::FORBIDDEN, "forbidden").into_response()
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, "Bearer realm=\"coauthor\"")],
        "unauthorized",
    )
        .into_response()
}

fn too_many() -> Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        [(header::RETRY_AFTER, RATE_WINDOW.as_secs().to_string())],
        "rate limit exceeded",
    )
        .into_response()
}

/// DNS-rebinding guard; runs before auth so a rebound page never reaches the token lookup.
async fn host_guard(State(gate): State<Gate>, req: Request, next: Next) -> Response {
    let host_ok = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(|h| h.to_ascii_lowercase())
        .is_some_and(|h| gate.allowed_hosts.contains(&h));
    if !host_ok || req.headers().contains_key(header::ORIGIN) {
        return forbidden();
    }
    next.run(req).await
}

async fn auth(State(gate): State<Gate>, mut req: Request, next: Next) -> Response {
    let deadline = tokio::time::Instant::now() + gate.cfg.auth_failure_floor;
    let client = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map_or_else(|| "unknown".to_string(), |c| c.0.ip().to_string());
    if gate.throttled(&client) {
        tokio::time::sleep_until(deadline).await;
        return too_many();
    }
    let token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| t.trim().to_string());
    let principal = match token {
        Some(token) => {
            gate.stats.auth_lookups.fetch_add(1, Ordering::Relaxed);
            let store = gate.store.clone();
            match tokio::task::spawn_blocking(move || store.authenticate(&token)).await {
                Ok(Ok(p)) => p,
                _ => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            }
        }
        None => None,
    };
    let Some(principal) = principal else {
        gate.record_failure(&client);
        tokio::time::sleep_until(deadline).await;
        return unauthorized();
    };
    if !gate.allow_token(&principal.token_id) {
        return too_many();
    }
    req.extensions_mut().insert(principal);
    next.run(req).await
}

/// The `/mcp` router plus its counters. Layers run outermost first: Host/Origin guard, then
/// auth and throttling, then the MCP service (which repeats its own Origin check).
pub fn router_with_stats(store: Store, cfg: McpConfig) -> (axum::Router, Arc<GateStats>) {
    let mcp_store = store.clone();
    let service = StreamableHttpService::new(
        move || Ok(CoauthorMcp::new(mcp_store.clone())),
        Arc::new(NeverSessionManager::default()),
        StreamableHttpServerConfig::default()
            .with_legacy_session_mode(false)
            .with_json_response(true)
            .with_sse_keep_alive(None)
            .enforce_origin_validation(),
    );
    let p = cfg.port;
    let gate = Gate {
        store,
        allowed_hosts: Arc::new(vec![
            format!("127.0.0.1:{p}"),
            format!("localhost:{p}"),
            format!("[::1]:{p}"),
        ]),
        cfg,
        per_token: Arc::default(),
        failures: Arc::default(),
        stats: Arc::default(),
    };
    let stats = gate.stats.clone();
    let app = axum::Router::new()
        .nest_service("/mcp", service)
        .layer(axum::middleware::from_fn_with_state(gate.clone(), auth))
        .layer(axum::middleware::from_fn_with_state(gate, host_guard));
    (app, stats)
}

pub fn router(store: Store, cfg: McpConfig) -> axum::Router {
    router_with_stats(store, cfg).0
}

/// Bind on loopback and serve until the process exits. Returns the bound address.
pub async fn serve(store: Store, port: u16) -> std::io::Result<SocketAddr> {
    let listener = tokio::net::TcpListener::bind((DEFAULT_HOST, port)).await?;
    let addr = listener.local_addr()?;
    let app = router(store, McpConfig::new(addr.port()));
    tokio::spawn(async move {
        let app = app.into_make_service_with_connect_info::<SocketAddr>();
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("MCP server stopped: {e}");
        }
    });
    Ok(addr)
}
