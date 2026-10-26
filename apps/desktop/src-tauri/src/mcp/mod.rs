//! In-app MCP server (RAD-209): Streamable HTTP at `/mcp` on 127.0.0.1, built on `rmcp`, the
//! official MCP Rust SDK, and sharing the app's SQLite store.
//!
//! - Listens on loopback only. Before anything else (and before any database lookup) the
//!   `Host` header must be exactly a loopback name plus our port (`127.0.0.1`, `localhost` or
//!   `[::1]`), and any `Origin` header is refused: this is the DNS-rebinding guard.
//! - Every request carries `Authorization: Bearer <agent token>` (RAD-205). Every auth failure
//!   (missing, malformed, unknown or revoked token) gets the same 401 body and is held to the
//!   same minimum response time, so responses don't reveal whether a token exists. Wrong
//!   tokens count toward a global throttle; requests with no token never do (a web page can
//!   send those with an `<img>` tag), and a valid token is never held back by the throttle.
//!   Valid tokens are rate limited per token.
//! - Each tool checks its scope and every call is written to `audit_events`.
//! - Agents may read, comment and suggest. Accepting or rejecting a suggestion is human-only
//!   and is never exposed as an MCP tool.

mod tools;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use rmcp::transport::streamable_http_server::session::never::NeverSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};

use crate::storage::Store;
use tokio::sync::Semaphore;
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
    /// Wrong-token attempts per window before further wrong tokens get 429.
    pub auth_failures_global: u32,
    /// Requests that may be past the token check at once (lookup plus handling). Requests
    /// without a token never take a slot.
    pub max_in_flight: usize,
    /// Concurrent token lookups (the store has one SQLite connection).
    pub max_lookups: usize,
    /// Every auth failure takes at least this long, whatever the reason.
    pub auth_failure_floor: Duration,
    /// How long a request waits for an in-flight slot before getting 503.
    pub in_flight_timeout: Duration,
    /// How long a request waits for a lookup slot before getting 503.
    pub lookup_timeout: Duration,
}

impl McpConfig {
    pub fn new(port: u16) -> Self {
        Self {
            port,
            rate_limit: RATE_LIMIT,
            auth_failures_global: 50,
            max_in_flight: 64,
            max_lookups: 4,
            auth_failure_floor: Duration::from_millis(250),
            in_flight_timeout: Duration::from_secs(5),
            lookup_timeout: Duration::from_secs(2),
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

#[derive(Clone)]
struct Gate {
    store: Store,
    cfg: McpConfig,
    allowed_hosts: Arc<Vec<String>>,
    per_token: Arc<Mutex<HashMap<String, Window>>>,
    failures: Arc<Mutex<Option<Window>>>,
    in_flight: Arc<Semaphore>,
    lookups: Arc<Semaphore>,
    probe: Arc<Semaphore>,
    stats: Arc<GateStats>,
}

impl Gate {
    fn allow_token(&self, token_id: &str) -> bool {
        let mut m = self.per_token.lock().expect("limiter poisoned");
        let now = Instant::now();
        let w = m.entry(token_id.to_string()).or_insert((now, 0));
        bump(w, now) <= self.cfg.rate_limit
    }

    fn budget_spent(&self) -> bool {
        let f = self.failures.lock().expect("limiter poisoned");
        f.as_ref()
            .is_some_and(|w| current(w, Instant::now()) >= self.cfg.auth_failures_global)
    }

    /// True when this wrong-token attempt is over the global budget. Counts the attempt.
    fn wrong_token_throttled(&self) -> bool {
        let mut f = self.failures.lock().expect("limiter poisoned");
        let now = Instant::now();
        let w = f.get_or_insert((now, 0));
        if current(w, now) >= self.cfg.auth_failures_global {
            return true;
        }
        bump(w, now);
        false
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

fn busy() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        [(header::RETRY_AFTER, "1")],
        "server busy",
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

/// `Authorization: Bearer <token>`, scheme matched case-insensitively.
fn bearer(req: &Request) -> Option<String> {
    let v = req.headers().get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = v.trim().split_once(' ')?;
    let token = token.trim();
    (scheme.eq_ignore_ascii_case("bearer") && !token.is_empty()).then(|| token.to_string())
}

async fn auth(State(gate): State<Gate>, mut req: Request, next: Next) -> Response {
    let deadline = tokio::time::Instant::now() + gate.cfg.auth_failure_floor;
    // No token: plain 401, not counted, so a web page can't use it to lock out agents.
    let Some(token) = bearer(&req) else {
        tokio::time::sleep_until(deadline).await;
        return unauthorized();
    };
    let hash = crate::agents::hash_token(&token);
    // Hashes of tokens that authenticated before (kept in the store so revocation clears them).
    // Once the wrong-token budget is spent, only these (plus one probe at a time) are looked up.
    let known = gate.store.is_known_token_hash(&hash);
    // Once the wrong-token budget is spent, unknown tokens don't reach the database except one
    // probe at a time (so a brand-new valid token still gets in). Known tokens always do.
    let _probe = if !known && gate.budget_spent() {
        match gate.probe.clone().try_acquire_owned() {
            Ok(p) => Some(p),
            Err(_) => {
                tokio::time::sleep_until(deadline).await;
                return too_many();
            }
        }
    } else {
        None
    };
    let slot = tokio::time::timeout(
        gate.cfg.in_flight_timeout,
        gate.in_flight.clone().acquire_owned(),
    )
    .await;
    let Ok(Ok(_slot)) = slot else {
        return busy();
    };
    let looked_up = {
        let Ok(Ok(_l)) =
            tokio::time::timeout(gate.cfg.lookup_timeout, gate.lookups.acquire()).await
        else {
            return busy();
        };
        gate.stats.auth_lookups.fetch_add(1, Ordering::Relaxed);
        let store = gate.store.clone();
        tokio::task::spawn_blocking(move || store.authenticate(&token)).await
    };
    drop(_probe);
    let principal = match looked_up {
        Ok(Ok(p)) => p,
        _ => {
            drop(_slot);
            tokio::time::sleep_until(deadline).await;
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let Some(principal) = principal else {
        drop(_slot);
        let throttled = gate.wrong_token_throttled();
        tokio::time::sleep_until(deadline).await;
        return if throttled {
            too_many()
        } else {
            unauthorized()
        };
    };
    if !gate.allow_token(&principal.token_id) {
        return too_many();
    }
    req.extensions_mut().insert(principal);
    next.run(req).await
}

/// Largest accepted request body. Checked after auth, so unauthenticated bodies are never read.
pub const MAX_BODY_BYTES: usize = 1024 * 1024;

/// The MCP service reads raw bodies (not through axum extractors), so axum's default limit
/// doesn't apply; buffer up to the cap here and refuse anything larger with 413.
async fn body_limit(req: Request, next: Next) -> Response {
    // A declared Content-Length over the cap is refused up front, before any body is read.
    let declared = req
        .headers()
        .get(header::CONTENT_LENGTH)
        .map(|v| v.to_str().ok().and_then(|s| s.trim().parse::<u64>().ok()));
    match declared {
        Some(Some(n)) if n > MAX_BODY_BYTES as u64 => return too_large(),
        Some(None) => return (StatusCode::BAD_REQUEST, "invalid content-length").into_response(),
        _ => {}
    }
    let (parts, body) = req.into_parts();
    match axum::body::to_bytes(body, MAX_BODY_BYTES).await {
        Ok(bytes) => {
            next.run(Request::from_parts(parts, axum::body::Body::from(bytes)))
                .await
        }
        Err(_) => too_large(),
    }
}

fn too_large() -> Response {
    (StatusCode::PAYLOAD_TOO_LARGE, "request body too large").into_response()
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
    let in_flight = Arc::new(Semaphore::new(cfg.max_in_flight));
    let lookups = Arc::new(Semaphore::new(cfg.max_lookups));
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
        in_flight,
        lookups,
        probe: Arc::new(Semaphore::new(1)),
        stats: Arc::default(),
    };
    let stats = gate.stats.clone();
    let app = axum::Router::new()
        .nest_service("/mcp", service)
        .layer(axum::middleware::from_fn(body_limit))
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
