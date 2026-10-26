//! In-app MCP server (RAD-209): Streamable HTTP at `/mcp` on 127.0.0.1, built on `rmcp`, the
//! official MCP Rust SDK, and sharing the app's SQLite store.
//!
//! - Listens on loopback only; `Host` must be a loopback name (DNS-rebinding guard) and any
//!   browser `Origin` header is rejected.
//! - Every request carries `Authorization: Bearer <agent token>` (RAD-205). Unknown or revoked
//!   tokens get 401; each token is rate limited.
//! - Each tool checks its scope and every call is written to `audit_events`.
//! - Agents may read, comment and suggest. Accepting or rejecting a suggestion is human-only
//!   and is never exposed as an MCP tool.

mod tools;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Request, State};
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

#[derive(Clone)]
struct Gate {
    store: Store,
    limiter: Arc<Mutex<HashMap<String, (Instant, u32)>>>,
    limit: u32,
}

impl Gate {
    fn allow(&self, token_id: &str) -> bool {
        let mut m = self.limiter.lock().expect("limiter poisoned");
        let now = Instant::now();
        let e = m.entry(token_id.to_string()).or_insert((now, 0));
        if now.duration_since(e.0) >= RATE_WINDOW {
            *e = (now, 0);
        }
        e.1 += 1;
        e.1 <= self.limit
    }
}

fn unauthorized(msg: &str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, "Bearer realm=\"coauthor\"")],
        msg.to_string(),
    )
        .into_response()
}

async fn auth(State(gate): State<Gate>, mut req: Request, next: Next) -> Response {
    let token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .map(str::to_string);
    let Some(token) = token else {
        return unauthorized("missing bearer token");
    };
    let store = gate.store.clone();
    let principal = tokio::task::spawn_blocking(move || store.authenticate(&token)).await;
    let principal = match principal {
        Ok(Ok(Some(p))) => p,
        Ok(Ok(None)) => return unauthorized("invalid or revoked token"),
        _ => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if !gate.allow(&principal.token_id) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            [(header::RETRY_AFTER, RATE_WINDOW.as_secs().to_string())],
            "rate limit exceeded",
        )
            .into_response();
    }
    req.extensions_mut().insert(principal);
    next.run(req).await
}

/// The `/mcp` router, with auth and the given per-token rate limit.
pub fn router_with_limit(store: Store, limit: u32) -> axum::Router {
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
    let gate = Gate {
        store,
        limiter: Arc::default(),
        limit,
    };
    axum::Router::new()
        .nest_service("/mcp", service)
        .layer(axum::middleware::from_fn_with_state(gate, auth))
}

pub fn router(store: Store) -> axum::Router {
    router_with_limit(store, RATE_LIMIT)
}

/// Bind on loopback and serve until the process exits. Returns the bound address.
pub async fn serve(store: Store, port: u16) -> std::io::Result<SocketAddr> {
    let listener = tokio::net::TcpListener::bind((DEFAULT_HOST, port)).await?;
    let addr = listener.local_addr()?;
    let app = router(store);
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("MCP server stopped: {e}");
        }
    });
    Ok(addr)
}
