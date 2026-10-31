//! MCP pairing (#188): unauthenticated request_pairing / poll_pairing only.

use coauthor_lib::{mcp, storage::Store};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

async fn post(url: &str, token: Option<&str>, body: Value) -> reqwest::Response {
    let mut req = reqwest::Client::new()
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", "2025-06-18")
        .json(&body);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    req.send().await.unwrap()
}

struct PairServer {
    url: String,
    store: Store,
    hooks: Arc<Mutex<Vec<String>>>,
    _tmp: tempfile::TempDir,
}

async fn start_pairing_server() -> PairServer {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(tmp.path()).unwrap();
    let hooks: Arc<Mutex<Vec<String>>> = Arc::default();
    let captured = hooks.clone();
    let hook: mcp::PairingRequestedHook = Arc::new(move |id| captured.lock().unwrap().push(id));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mut cfg = mcp::McpConfig::new(addr.port());
    cfg.auth_failure_floor = std::time::Duration::from_millis(5);
    let (app, _) = mcp::router_with_stats(store.clone(), cfg, Some(hook));
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service())
            .await
            .unwrap();
    });
    PairServer {
        url: format!("http://{addr}/mcp"),
        store,
        hooks,
        _tmp: tmp,
    }
}

async fn tool_call(url: &str, token: Option<&str>, name: &str, args: Value) -> Value {
    let r = post(
        url,
        token,
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": { "name": name, "arguments": args }
        }),
    )
    .await;
    assert_eq!(r.status(), 200, "{name}");
    r.json::<Value>().await.unwrap()["result"].clone()
}

#[tokio::test]
async fn unauthenticated_non_pairing_tools_get_401() {
    let s = start_pairing_server().await;
    let r = post(
        &s.url,
        None,
        json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_documents","arguments":{}}}),
    )
    .await;
    assert_eq!(r.status(), 401);
}

#[tokio::test]
async fn pairing_request_poll_and_approve_over_mcp() {
    let s = start_pairing_server().await;
    let req = tool_call(
        &s.url,
        None,
        "request_pairing",
        json!({ "name": "Helper Bot", "color": "#3366ff" }),
    )
    .await;
    assert_ne!(req["isError"], true);
    let pairing_id = req["structuredContent"]["pairingId"]
        .as_str()
        .unwrap()
        .to_string();
    let secret = req["structuredContent"]["pairingSecret"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(req["structuredContent"]["status"], "pending");
    assert!(s.hooks.lock().unwrap().contains(&pairing_id));

    let pending = tool_call(
        &s.url,
        None,
        "poll_pairing",
        json!({ "pairing_id": pairing_id, "pairing_secret": secret }),
    )
    .await;
    assert_eq!(pending["structuredContent"]["status"], "pending");

    s.store.approve_pairing(&pairing_id, None).unwrap();

    let ok = tool_call(
        &s.url,
        None,
        "poll_pairing",
        json!({ "pairing_id": pairing_id, "pairing_secret": secret }),
    )
    .await;
    assert_eq!(ok["structuredContent"]["status"], "approved");
    let token = ok["structuredContent"]["token"].as_str().unwrap();
    assert!(token.starts_with("cat_"));

    let again = tool_call(
        &s.url,
        None,
        "poll_pairing",
        json!({ "pairing_id": pairing_id, "pairing_secret": secret }),
    )
    .await;
    assert_eq!(again["structuredContent"]["status"], "denied");
}

#[tokio::test]
async fn deny_and_wrong_secret_over_mcp() {
    let s = start_pairing_server().await;
    let req = tool_call(&s.url, None, "request_pairing", json!({ "name": "Bot" })).await;
    let id = req["structuredContent"]["pairingId"].as_str().unwrap();
    let secret = req["structuredContent"]["pairingSecret"].as_str().unwrap();

    let bad = tool_call(
        &s.url,
        None,
        "poll_pairing",
        json!({ "pairing_id": id, "pairing_secret": "pair_nope" }),
    )
    .await;
    assert_eq!(bad["structuredContent"]["status"], "denied");

    s.store.deny_pairing(id).unwrap();
    let denied = tool_call(
        &s.url,
        None,
        "poll_pairing",
        json!({ "pairing_id": id, "pairing_secret": secret }),
    )
    .await;
    assert_eq!(denied["structuredContent"]["status"], "denied");
}

#[tokio::test]
async fn pairing_rate_limit() {
    let s = start_pairing_server().await;
    for i in 0..5 {
        let r = tool_call(
            &s.url,
            None,
            "request_pairing",
            json!({ "name": format!("Bot {i}") }),
        )
        .await;
        assert_ne!(r["isError"], true, "{r}");
        let id = r["structuredContent"]["pairingId"].as_str().unwrap();
        s.store.deny_pairing(id).unwrap();
    }
    let r = tool_call(
        &s.url,
        None,
        "request_pairing",
        json!({ "name": "One too many" }),
    )
    .await;
    assert_eq!(r["isError"], true);
}
