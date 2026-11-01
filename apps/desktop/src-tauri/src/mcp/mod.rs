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

mod port_holder;
mod tools;
pub use tools::PARAGRAPH_STYLES;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use rmcp::transport::streamable_http_server::session::never::NeverSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};

use crate::storage::Store;
use tokio::sync::Semaphore;
pub use tools::SwarmdraftMcp;

/// Called when a bot opens an MCP pairing request (#188).
pub type PairingRequestedHook = Arc<dyn Fn(String) + Send + Sync>;

/// Set on unauthenticated MCP requests allowed to reach pairing tools only.
#[derive(Clone, Copy, Debug)]
pub(crate) struct PairingGuest;

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
    /// Wrong-token auth failures since startup (stable under concurrent requests).
    unknown_failures: Arc<AtomicU32>,
    stats: Arc<GateStats>,
}

impl Gate {
    fn allow_token(&self, token_id: &str) -> bool {
        let mut m = self.per_token.lock().expect("limiter poisoned");
        let now = Instant::now();
        let w = m.entry(token_id.to_string()).or_insert((now, 0));
        bump(w, now) <= self.cfg.rate_limit
    }

    fn unknown_budget_spent(&self) -> bool {
        self.unknown_failures.load(Ordering::Acquire) >= self.cfg.auth_failures_global
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
        self.unknown_failures.fetch_add(1, Ordering::Release);
        false
    }
}

fn forbidden() -> Response {
    (StatusCode::FORBIDDEN, "forbidden").into_response()
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, "Bearer realm=\"swarmdraft\"")],
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

/// MCP methods reachable without a bearer token (#188). Every other call must 401.
pub(crate) fn unauthenticated_mcp_allowed(body: &[u8]) -> bool {
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(body) else {
        return false;
    };
    let Some(method) = v.get("method").and_then(|m| m.as_str()) else {
        return false;
    };
    match method {
        "initialize" | "notifications/initialized" | "ping" => true,
        "tools/call" => v
            .get("params")
            .and_then(|p| p.get("name"))
            .and_then(|n| n.as_str())
            .is_some_and(|n| n == "request_pairing" || n == "poll_pairing"),
        _ => false,
    }
}

async fn auth(State(gate): State<Gate>, mut req: Request, next: Next) -> Response {
    let deadline = tokio::time::Instant::now() + gate.cfg.auth_failure_floor;
    let Some(token) = bearer(&req) else {
        let (parts, body) = req.into_parts();
        let bytes = match axum::body::to_bytes(body, MAX_BODY_BYTES).await {
            Ok(b) => b,
            Err(_) => return too_large(),
        };
        if unauthenticated_mcp_allowed(&bytes) {
            req = Request::from_parts(parts, axum::body::Body::from(bytes));
            req.extensions_mut().insert(PairingGuest);
            return next.run(req).await;
        }
        tokio::time::sleep_until(deadline).await;
        return unauthorized();
    };
    let hash = crate::agents::hash_token(&token);
    // Hashes of tokens that authenticated before (kept in the store so revocation clears them).
    // Once the wrong-token budget is spent, only these (plus one probe at a time) are looked up.
    let known = gate.store.is_known_token_hash(&hash);
    // Once the wrong-token budget is spent, unknown tokens don't reach the database except one
    // probe at a time (so a brand-new valid token still gets in). Known tokens always do.
    let _probe = if !known && gate.unknown_budget_spent() {
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

/// Largest accepted request body. Checked before auth so pairing handshakes can be inspected safely.
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

/// PowerShell 5.1 defaults to ISO-8859-1 when `Content-Type` has no charset (#234).
async fn utf8_content_type(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    if let Some(v) = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
    {
        let needs = (v.starts_with("application/json") || v.starts_with("text/event-stream"))
            && !v.to_ascii_lowercase().contains("charset=");
        if needs {
            if let Ok(h) = HeaderValue::from_str(&format!("{v}; charset=utf-8")) {
                res.headers_mut().insert(header::CONTENT_TYPE, h);
            }
        }
    }
    res
}

/// The `/mcp` router plus its counters. Layers run outermost first: Host/Origin guard, body limit,
/// then auth (pairing bypass reads the buffered body), then the MCP service.
pub fn router_with_stats(
    store: Store,
    cfg: McpConfig,
    pairing_hook: Option<PairingRequestedHook>,
) -> (axum::Router, Arc<GateStats>) {
    let mcp_store = store.clone();
    let hook = pairing_hook.clone();
    let service = StreamableHttpService::new(
        move || Ok(SwarmdraftMcp::new(mcp_store.clone(), hook.clone())),
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
        unknown_failures: Arc::new(AtomicU32::new(0)),
        stats: Arc::default(),
    };
    let stats = gate.stats.clone();
    let app = axum::Router::new()
        .nest_service("/mcp", service)
        .layer(axum::middleware::from_fn(utf8_content_type))
        .layer(axum::middleware::from_fn_with_state(gate.clone(), auth))
        .layer(axum::middleware::from_fn(body_limit))
        .layer(axum::middleware::from_fn_with_state(gate, host_guard));
    (app, stats)
}

pub fn router(
    store: Store,
    cfg: McpConfig,
    pairing_hook: Option<PairingRequestedHook>,
) -> axum::Router {
    router_with_stats(store, cfg, pairing_hook).0
}

/// When another program holds the MCP port and it is not the legacy desktop app.
pub const PORT_IN_USE_GENERIC_MESSAGE: &str =
    "Your bots can't connect because another program is already using the bot connection. Close that program, then restart swarmDraft.";

/// When the pre-rename coAuthor app still holds the shared MCP port.
pub const PORT_IN_USE_LEGACY_COAUTHOR_MESSAGE: &str =
    "Your bots can't connect because the old coAuthor app is still open. Close it, then restart swarmDraft.";

/// User-visible text for a taken MCP port (legacy name kept for callers that only need one string).
/// User-visible port-busy text from a legacy-coAuthor detection result (also used in tests).
pub fn port_in_use_user_message_if_legacy(legacy_coauthor: bool) -> String {
    if legacy_coauthor {
        PORT_IN_USE_LEGACY_COAUTHOR_MESSAGE.to_string()
    } else {
        PORT_IN_USE_GENERIC_MESSAGE.to_string()
    }
}

pub fn port_in_use_user_message(port: u16) -> String {
    port_in_use_user_message_if_legacy(port_holder::legacy_coauthor_holds_port(DEFAULT_HOST, port))
}

/// Bind the MCP port on loopback synchronously, so startup can tell the user right away when
/// another process already holds it.
pub fn bind(port: u16) -> std::io::Result<std::net::TcpListener> {
    match std::net::TcpListener::bind((DEFAULT_HOST, port)) {
        Ok(l) => {
            l.set_nonblocking(true)?;
            Ok(l)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            // Port and OS error go to the log only; the user sees plain wording.
            eprintln!("swarmDraft: MCP port {port} on {DEFAULT_HOST} is in use: {e}");
            Err(std::io::Error::new(
                std::io::ErrorKind::AddrInUse,
                port_in_use_user_message(port),
            ))
        }
        Err(e) => Err(e),
    }
}

/// Serve on a listener from [`bind`] until the process exits. Returns the bound address.
pub async fn serve_on(
    store: Store,
    listener: std::net::TcpListener,
    pairing_hook: Option<PairingRequestedHook>,
) -> std::io::Result<SocketAddr> {
    let listener = tokio::net::TcpListener::from_std(listener)?;
    let addr = listener.local_addr()?;
    let app = router(store, McpConfig::new(addr.port()), pairing_hook);
    tokio::spawn(async move {
        let app = app.into_make_service_with_connect_info::<SocketAddr>();
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("MCP server stopped: {e}");
        }
    });
    Ok(addr)
}

/// Bind on loopback and serve until the process exits. Returns the bound address.
pub async fn serve(
    store: Store,
    port: u16,
    pairing_hook: Option<PairingRequestedHook>,
) -> std::io::Result<SocketAddr> {
    serve_on(store, bind(port)?, pairing_hook).await
}
