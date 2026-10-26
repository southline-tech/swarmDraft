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
    _tmp: tempfile::TempDir,
}

pub async fn start(scopes: &[&str], limit: u32) -> Server {
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
    let app = mcp::router_with_limit(store.clone(), limit);
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Server {
        url: format!("http://{addr}/mcp"),
        store,
        token,
        manuscript_id: m.id,
        section_id: s.id,
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

#[tokio::test]
async fn host_origin_and_rate_limit() {
    let s = start(&["read"], 3).await;
    let body = json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}});
    let client = reqwest::Client::new();
    let base = || {
        client
            .post(&s.url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .bearer_auth(&s.token)
            .json(&body)
    };
    // DNS-rebinding guard: a non-loopback Host is refused.
    let r = base()
        .header("Host", "attacker.example")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
    // Browser pages may not call the server.
    let r = base()
        .header("Origin", "https://attacker.example")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
    // Auth and the per-token limit run first, so the refused calls above count too.
    assert_eq!(base().send().await.unwrap().status(), 200);
    let r = base().send().await.unwrap();
    assert_eq!(r.status(), 429);
    assert_eq!(r.headers().get("retry-after").unwrap(), "60");
}
