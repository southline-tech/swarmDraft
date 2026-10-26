//! Protocol tests for the in-app MCP server: raw JSON-RPC over Streamable HTTP, the way an
//! MCP inspector or agent client talks to it. Uses only synthetic text.

use coauthor_lib::{mcp, storage::Store};
use serde_json::{json, Value};

const SECTION_FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../fixtures/mcp/synthetic-section.json"
);

pub struct Server {
    pub url: String,
    pub store: Store,
    pub token: String,
    pub manuscript_id: String,
    pub section_id: String,
    pub stats: std::sync::Arc<mcp::GateStats>,
    _tmp: tempfile::TempDir,
}

pub async fn start(scopes: &[&str], limit: u32) -> Server {
    start_with(scopes, |c| c.rate_limit = limit).await
}

pub async fn start_with(scopes: &[&str], tune: impl FnOnce(&mut mcp::McpConfig)) -> Server {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(tmp.path()).unwrap();
    let agent = store.create_agent("Grok Bot", "#3366ff").unwrap();
    let scopes: Vec<String> = scopes.iter().map(|s| s.to_string()).collect();
    let token = store.create_token(&agent.id, Some(&scopes)).unwrap().token;
    let fixture: Value =
        serde_json::from_str(&std::fs::read_to_string(SECTION_FIXTURE).unwrap()).unwrap();
    let m = store.create_manuscript("Sample Manuscript").unwrap();
    let s = store
        .import_section_json(&m.id, "chapter", "Chapter One", &fixture["doc"])
        .unwrap();
    store
        .import_section_json(&m.id, "chapter", "Chapter Two", &json!({"type":"doc","content":[{"type":"paragraph","attrs":{"style":"body"},"content":[{"type":"text","text":"The lantern flickered twice."}]}]}))
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mut cfg = mcp::McpConfig::new(addr.port());
    cfg.auth_failure_floor = std::time::Duration::from_millis(20);
    tune(&mut cfg);
    let (app, stats) = mcp::router_with_stats(store.clone(), cfg);
    let app = app.into_make_service_with_connect_info::<std::net::SocketAddr>();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Server {
        url: format!("http://{addr}/mcp"),
        store,
        token,
        manuscript_id: m.id,
        section_id: s.id,
        stats,
        _tmp: tmp,
    }
}

pub async fn post(url: &str, token: Option<&str>, body: Value) -> reqwest::Response {
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

pub async fn rpc(s: &Server, method: &str, params: Value) -> Value {
    let r = post(
        &s.url,
        Some(&s.token),
        json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}),
    )
    .await;
    assert_eq!(r.status(), 200, "{method}");
    r.json().await.unwrap()
}

pub async fn call(s: &Server, tool: &str, args: Value) -> Value {
    let v = rpc(s, "tools/call", json!({"name": tool, "arguments": args})).await;
    v["result"].clone()
}

fn text(result: &Value) -> String {
    result["content"][0]["text"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn initialize_and_list_tools() {
    let s = start(&["read", "comment", "suggest"], 1000).await;
    let init = rpc(
        &s,
        "initialize",
        json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "protocol-test", "version": "0"}
        }),
    )
    .await;
    assert!(
        init["result"]["capabilities"]["tools"].is_object(),
        "{init}"
    );
    let n = post(
        &s.url,
        Some(&s.token),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
    )
    .await;
    assert!(n.status().is_success());
    let list = rpc(&s, "tools/list", json!({})).await;
    let names: Vec<&str> = list["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    for t in [
        "list_documents",
        "list_chapters",
        "read_chapter",
        "search_text",
    ] {
        assert!(names.contains(&t), "missing {t}: {names:?}");
    }
    // Deciding on suggestions is human-only.
    assert!(!names
        .iter()
        .any(|n| n.contains("accept") || n.contains("reject") || n.contains("decide")));
    for t in list["result"]["tools"].as_array().unwrap() {
        assert_eq!(t["inputSchema"]["type"], "object");
    }
}

#[tokio::test]
async fn read_tools_return_structure_and_footnotes() {
    let s = start(&["read"], 1000).await;
    let docs = call(&s, "list_documents", json!({})).await;
    assert_eq!(
        docs["structuredContent"]["documents"][0]["title"],
        "Sample Manuscript"
    );
    assert_eq!(docs["structuredContent"]["documents"][0]["sectionCount"], 2);

    let ch = call(
        &s,
        "list_chapters",
        json!({"manuscript_id": s.manuscript_id}),
    )
    .await;
    let secs = ch["structuredContent"]["sections"].as_array().unwrap();
    assert_eq!(secs.len(), 2);
    assert_eq!(secs[0]["kind"], "chapter");
    assert!(secs[0]["wordCount"].as_u64().unwrap() > 0);

    let js = call(
        &s,
        "read_chapter",
        json!({"manuscript_id": s.manuscript_id, "section_id": s.section_id, "format": "json"}),
    )
    .await;
    let sc = &js["structuredContent"];
    let blocks = sc["blocks"].as_array().unwrap();
    assert!(blocks
        .iter()
        .all(|b| b["id"].as_str().unwrap().starts_with('b')));
    let fixture: Value =
        serde_json::from_str(&std::fs::read_to_string(SECTION_FIXTURE).unwrap()).unwrap();
    assert_eq!(sc["readView"], fixture["readView"]);
    assert!(!sc["readView"]["footnotes"].as_array().unwrap().is_empty());

    let md = text(
        &call(
            &s,
            "read_chapter",
            json!({"manuscript_id": s.manuscript_id, "section_id": s.section_id}),
        )
        .await,
    );
    assert!(md.starts_with("# Chapter One"));
    assert!(md.contains(&format!(
        "<!-- block:{} -->",
        blocks[0]["id"].as_str().unwrap()
    )));
    assert!(
        md.contains("{++") && md.contains("{--") && md.contains("[^"),
        "{md}"
    );

    // Ids are stable between reads.
    let again = call(
        &s,
        "read_chapter",
        json!({"manuscript_id": s.manuscript_id, "section_id": s.section_id, "format": "json"}),
    )
    .await;
    assert_eq!(again["structuredContent"]["blocks"], sc["blocks"]);

    let hits = call(
        &s,
        "search_text",
        json!({"manuscript_id": s.manuscript_id, "query": "LANTERN"}),
    )
    .await;
    let m = &hits["structuredContent"]["matches"][0];
    assert_eq!(m["quote"], "lantern");
    assert_eq!(m["offset"], 4);
    assert_eq!(m["sectionTitle"], "Chapter Two");

    let missing = call(
        &s,
        "read_chapter",
        json!({"manuscript_id": s.manuscript_id, "section_id": "nope"}),
    )
    .await;
    assert_eq!(missing["isError"], true);

    let log = s.store.audit_log().unwrap();
    let actions: Vec<&str> = log.iter().map(|r| r.1.as_str()).collect();
    assert_eq!(
        actions,
        [
            "list_documents",
            "list_chapters",
            "read_chapter",
            "read_chapter",
            "read_chapter",
            "search_text",
            "read_chapter"
        ]
    );
    assert_eq!(log.last().unwrap().2, "error");
    assert!(
        log.iter().all(|r| !r.3.contains("cat_")),
        "tokens must not be audited"
    );
}

#[tokio::test]
async fn auth_is_required_and_enforced() {
    let s = start(&["comment"], 1000).await;
    let body = json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}});
    let r = post(&s.url, None, body.clone()).await;
    assert_eq!(r.status(), 401);
    assert!(r
        .headers()
        .get("www-authenticate")
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("Bearer"));
    assert_eq!(
        post(&s.url, Some("cat_not-a-real-token"), body.clone())
            .await
            .status(),
        401
    );

    // Missing scope: the call is refused and audited as denied.
    let denied = call(&s, "list_documents", json!({})).await;
    assert_eq!(denied["isError"], true);
    assert!(text(&denied).contains("'read' scope"));
    assert_eq!(s.store.audit_log().unwrap()[0].2, "denied");

    // Revoked tokens stop working immediately.
    let agent = &s.store.list_agents().unwrap()[0];
    let t = s.store.list_tokens(&agent.id).unwrap();
    s.store.revoke_token(&t[0].id).unwrap();
    assert_eq!(post(&s.url, Some(&s.token), body).await.status(), 401);
}

fn lookups(s: &Server) -> u64 {
    s.stats
        .auth_lookups
        .load(std::sync::atomic::Ordering::Relaxed)
}

#[tokio::test]
async fn rebinding_host_or_origin_is_refused_before_any_lookup() {
    let s = start(&["read"], 1000).await;
    let port = s
        .url
        .split(':')
        .nth(2)
        .unwrap()
        .split('/')
        .next()
        .unwrap()
        .to_string();
    let body = json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}});
    let client = reqwest::Client::new();
    let send = |host: Option<String>, origin: Option<&str>| {
        let mut r = client
            .post(&s.url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .bearer_auth(&s.token)
            .json(&body);
        if let Some(h) = host {
            r = r.header("Host", h);
        }
        if let Some(o) = origin {
            r = r.header("Origin", o);
        }
        r.send()
    };
    let refused = [
        (Some("attacker.example".to_string()), None),
        (Some(format!("attacker.example:{port}")), None),
        (Some("127.0.0.1:1".to_string()), None),
        (Some("127.0.0.1".to_string()), None),
        (Some(format!("127.0.0.1.attacker.example:{port}")), None),
        (None, Some("https://attacker.example")),
        (None, Some("http://127.0.0.1")),
    ];
    for (host, origin) in refused {
        let r = send(host.clone(), origin).await.unwrap();
        assert_eq!(r.status(), 403, "{host:?} {origin:?}");
    }
    assert_eq!(lookups(&s), 0, "refused before the token lookup");
    for host in [
        format!("localhost:{port}"),
        format!("127.0.0.1:{port}"),
        format!("LOCALHOST:{port}"),
    ] {
        assert_eq!(send(Some(host), None).await.unwrap().status(), 200);
    }
    assert_eq!(lookups(&s), 3);
}

#[tokio::test]
async fn per_token_rate_limit() {
    let s = start(&["read"], 2).await;
    let body = json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}});
    assert_eq!(
        post(&s.url, Some(&s.token), body.clone()).await.status(),
        200
    );
    assert_eq!(
        post(&s.url, Some(&s.token), body.clone()).await.status(),
        200
    );
    let r = post(&s.url, Some(&s.token), body).await;
    assert_eq!(r.status(), 429);
    assert_eq!(r.headers().get("retry-after").unwrap(), "60");
}

#[tokio::test]
async fn auth_failures_look_identical() {
    let floor = std::time::Duration::from_millis(150);
    let s = start_with(&["read"], |c| c.auth_failure_floor = floor).await;
    let agent = &s.store.list_agents().unwrap()[0];
    let revoked = s.store.create_token(&agent.id, None).unwrap();
    s.store.revoke_token(&revoked.info.id).unwrap();
    let body = json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}});

    let mut seen = Vec::new();
    for token in [
        None,
        Some("garbage"),
        Some("cat_not-a-real-token"),
        Some(revoked.token.as_str()),
    ] {
        let t0 = std::time::Instant::now();
        let r = post(&s.url, token, body.clone()).await;
        let elapsed = t0.elapsed();
        assert_eq!(r.status(), 401);
        assert!(elapsed >= floor, "{token:?} answered in {elapsed:?}");
        let www = r
            .headers()
            .get("www-authenticate")
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        seen.push((www, r.text().await.unwrap()));
    }
    assert!(seen.windows(2).all(|w| w[0] == w[1]), "{seen:?}");
}

#[tokio::test]
async fn wrong_tokens_are_throttled_but_a_valid_token_still_works() {
    let s = start_with(&["read"], |c| c.auth_failures_global = 2).await;
    let body = json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}});
    for _ in 0..2 {
        assert_eq!(
            post(&s.url, Some("cat_wrong"), body.clone()).await.status(),
            401
        );
    }
    let r = post(&s.url, Some("cat_wrong"), body.clone()).await;
    assert_eq!(r.status(), 429);
    assert_eq!(r.headers().get("retry-after").unwrap(), "60");
    assert_eq!(post(&s.url, Some(&s.token), body).await.status(), 200);
}

#[tokio::test]
async fn no_token_flood_cannot_lock_out_the_agent() {
    // What a web page can do with <img src=http://127.0.0.1:PORT/mcp>: no token, no Origin.
    let s = start_with(&["read"], |c| c.auth_failures_global = 3).await;
    let client = reqwest::Client::new();
    let flood: Vec<_> = (0..60)
        .map(|_| tokio::spawn(client.get(&s.url).send()))
        .collect();
    for h in flood {
        assert_eq!(h.await.unwrap().unwrap().status(), 401);
    }
    assert_eq!(lookups(&s), 0, "no-token requests never reach the database");
    let body = json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}});
    assert_eq!(post(&s.url, Some(&s.token), body).await.status(), 200);
}
