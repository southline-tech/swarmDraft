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

// ---- RAD-210 write tools ----

async fn chapter_two(s: &Server) -> (String, String) {
    let ch = call(
        s,
        "list_chapters",
        json!({"manuscript_id": s.manuscript_id}),
    )
    .await;
    let sid = ch["structuredContent"]["sections"][1]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let js = call(
        s,
        "read_chapter",
        json!({"manuscript_id": s.manuscript_id, "section_id": sid, "format": "json"}),
    )
    .await;
    let bid = js["structuredContent"]["blocks"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    (sid, bid)
}

async fn read_json(s: &Server, sid: &str) -> Value {
    call(
        s,
        "read_chapter",
        json!({"manuscript_id": s.manuscript_id, "section_id": sid, "format": "json"}),
    )
    .await["structuredContent"]
        .clone()
}

async fn read_md(s: &Server, sid: &str) -> String {
    text(
        &call(
            s,
            "read_chapter",
            json!({"manuscript_id": s.manuscript_id, "section_id": sid}),
        )
        .await,
    )
}

#[tokio::test]
async fn write_tools_listed_and_decisions_absent() {
    let s = start(&["read", "comment", "suggest"], 1000).await;
    let list = rpc(&s, "tools/list", json!({})).await;
    let names: Vec<&str> = list["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    for t in ["add_comment", "suggest_edit", "suggest_style"] {
        assert!(names.contains(&t), "missing {t}");
    }
    assert_eq!(names.len(), 7, "{names:?}");
    let r = call(&s, "accept_suggestion", json!({"id": "x"})).await;
    let r2 = rpc(
        &s,
        "tools/call",
        json!({"name": "accept_suggestion", "arguments": {"id": "x"}}),
    )
    .await;
    assert!(r.is_null() || r["isError"] == true, "{r}");
    assert!(
        r2.get("error").is_some() || r2["result"]["isError"] == true,
        "{r2}"
    );
}

#[tokio::test]
async fn add_comment_is_anchored_and_attributed() {
    let s = start(&["read", "comment"], 1000).await;
    let (sid, bid) = chapter_two(&s).await;
    let r = call(&s, "add_comment", json!({"manuscript_id": s.manuscript_id, "section_id": sid, "block_id": bid, "quote": "lantern", "body": "Which lantern?"})).await;
    assert_ne!(r["isError"], true, "{r}");
    let c = &r["structuredContent"]["comment"];
    let cid = c["id"].as_str().unwrap();
    assert_eq!(c["author"]["kind"], "agent");
    assert_eq!(c["author"]["name"], "Grok Bot");

    let md = read_md(&s, &sid).await;
    assert!(
        md.contains(&format!(
            "The {{==lantern==}}{{>>comment:{cid}<<}} flickered twice."
        )),
        "{md}"
    );
    assert!(md.contains(&format!("comment:{cid} by Grok Bot")), "{md}");

    let reply = call(&s, "add_comment", json!({"manuscript_id": s.manuscript_id, "section_id": sid, "thread_id": cid, "body": "Follow-up."})).await;
    assert_eq!(reply["structuredContent"]["comment"]["blockId"], bid);
    assert_eq!(
        read_json(&s, &sid).await["comments"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    let stale = call(&s, "add_comment", json!({"manuscript_id": s.manuscript_id, "section_id": sid, "block_id": bid, "quote": "candle", "body": "x"})).await;
    assert_eq!(stale["isError"], true);
    assert!(text(&stale).contains("stale anchor"));
    let amb = call(&s, "add_comment", json!({"manuscript_id": s.manuscript_id, "section_id": sid, "block_id": bid, "quote": "e", "body": "x"})).await;
    assert!(text(&amb).contains("ambiguous anchor"), "{amb}");
    let bad_block = call(&s, "add_comment", json!({"manuscript_id": s.manuscript_id, "section_id": sid, "block_id": "b1.999999", "quote": "lantern", "body": "x"})).await;
    assert!(text(&bad_block).contains("not found"));

    // No suggest scope on this token.
    let denied = call(&s, "suggest_edit", json!({"manuscript_id": s.manuscript_id, "section_id": sid, "block_id": bid, "quote": "twice", "replacement": "again"})).await;
    assert!(text(&denied).contains("'suggest' scope"));
    let log = s.store.audit_log().unwrap();
    assert_eq!(log.last().unwrap().1, "suggest_edit");
    assert_eq!(log.last().unwrap().2, "denied");
}

#[tokio::test]
async fn suggest_edit_is_tracked_never_applied() {
    let s = start(&["read", "suggest"], 1000).await;
    let (sid, bid) = chapter_two(&s).await;
    let r = call(&s, "suggest_edit", json!({"manuscript_id": s.manuscript_id, "section_id": sid, "block_id": bid, "quote": "flickered", "replacement": "guttered", "rationale": "Stronger verb."})).await;
    assert_ne!(r["isError"], true, "{r}");
    let x = &r["structuredContent"]["suggestion"];
    let xid = x["id"].as_str().unwrap();
    assert_eq!(x["kind"], "replace");
    assert_eq!(x["status"], "open");

    let md = read_md(&s, &sid).await;
    assert!(md.contains(&format!("The lantern {{--flickered--}}{{>>suggestion:{xid}<<}}{{++guttered++}}{{>>suggestion:{xid}<<}} twice.")), "{md}");
    let js = read_json(&s, &sid).await;
    // Nothing is applied: the original text is still there, marked for deletion.
    let content0 = js["blocks"][0]["node"]["content"].as_array().unwrap();
    let del = content0.iter().find(|n| n["text"] == "flickered").unwrap();
    assert_eq!(del["marks"][0]["type"], "suggestion_delete");
    let content = js["blocks"][0]["node"]["content"].as_array().unwrap();
    let ins = content.iter().find(|n| n["text"] == "guttered").unwrap();
    assert_eq!(ins["marks"][0]["type"], "suggestion_insert");
    assert_eq!(
        ins["marks"][0]["attrs"]["author"],
        format!("agent:{}", x["author"]["id"].as_str().unwrap())
    );

    // Search sees the visible text, not the pending insert.
    let hits = call(
        &s,
        "search_text",
        json!({"manuscript_id": s.manuscript_id, "query": "guttered"}),
    )
    .await;
    assert!(hits["structuredContent"]["matches"]
        .as_array()
        .unwrap()
        .is_empty());

    let overlap = call(&s, "suggest_edit", json!({"manuscript_id": s.manuscript_id, "section_id": sid, "block_id": bid, "quote": "flickered", "replacement": "dimmed"})).await;
    assert!(text(&overlap).contains("pending suggestion"), "{overlap}");

    let del = call(&s, "suggest_edit", json!({"manuscript_id": s.manuscript_id, "section_id": sid, "block_id": bid, "quote": " twice", "replacement": ""})).await;
    assert_eq!(del["structuredContent"]["suggestion"]["kind"], "delete");

    let st = call(&s, "suggest_style", json!({"manuscript_id": s.manuscript_id, "section_id": sid, "block_id": bid, "style": "centered"})).await;
    assert_eq!(st["structuredContent"]["suggestion"]["kind"], "style");
    let bad = call(&s, "suggest_style", json!({"manuscript_id": s.manuscript_id, "section_id": sid, "block_id": bid, "style": "huge"})).await;
    assert!(text(&bad).contains("unknown style"));
    assert_eq!(
        read_json(&s, &sid).await["suggestions"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    // The paragraph style itself is unchanged.
    assert_eq!(
        read_json(&s, &sid).await["blocks"][0]["node"]["attrs"]["style"],
        "body"
    );
}

#[tokio::test]
async fn concurrent_suggestions_merge() {
    let s = start(&["read", "suggest"], 1000).await;
    let (sid, bid) = chapter_two(&s).await;
    let a = json!({"manuscript_id": s.manuscript_id, "section_id": sid, "block_id": bid, "quote": "lantern", "replacement": "lamp"});
    let b = json!({"manuscript_id": s.manuscript_id, "section_id": sid, "block_id": bid, "quote": "twice", "replacement": "once"});
    let (ra, rb) = tokio::join!(call(&s, "suggest_edit", a), call(&s, "suggest_edit", b));
    assert_ne!(ra["isError"], true);
    assert_ne!(rb["isError"], true);
    let md = read_md(&s, &sid).await;
    assert!(
        md.contains("{--lantern--}") && md.contains("{++lamp++}"),
        "{md}"
    );
    assert!(
        md.contains("{--twice--}") && md.contains("{++once++}"),
        "{md}"
    );
    let hits = call(
        &s,
        "search_text",
        json!({"manuscript_id": s.manuscript_id, "query": "The lantern flickered twice."}),
    )
    .await;
    assert_eq!(
        hits["structuredContent"]["matches"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
