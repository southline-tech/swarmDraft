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
async fn bearer_scheme_is_case_insensitive() {
    let s = start(&["read"], 1000).await;
    let body = json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}});
    for scheme in ["bearer", "BEARER", "Bearer"] {
        let r = reqwest::Client::new()
            .post(&s.url)
            .header("authorization", format!("{scheme} {}", s.token))
            .header("accept", "application/json, text/event-stream")
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200, "{scheme}");
    }
}

#[tokio::test]
async fn spent_budget_stops_wrong_token_lookups_but_not_the_agent() {
    let s = start_with(&["read"], |c| c.auth_failures_global = 3).await;
    let body = json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}});
    // The agent has authenticated before, so its token is known.
    assert_eq!(
        post(&s.url, Some(&s.token), body.clone()).await.status(),
        200
    );
    for _ in 0..3 {
        assert_eq!(
            post(&s.url, Some("cat_wrong"), body.clone()).await.status(),
            401
        );
    }
    let before = lookups(&s);
    let flood: Vec<_> = (0..50)
        .map(|i| {
            let url = s.url.clone();
            let body = body.clone();
            tokio::spawn(async move {
                post(&url, Some(&format!("cat_wrong{i}")), body)
                    .await
                    .status()
            })
        })
        .collect();
    for h in flood {
        assert_eq!(h.await.unwrap(), 429);
    }
    let probed = lookups(&s) - before;
    assert!(
        probed < 50,
        "only single probes reach the database, got {probed}"
    );
    assert_eq!(post(&s.url, Some(&s.token), body).await.status(), 200);
}

#[tokio::test]
async fn in_flight_cap_queues_rather_than_fails() {
    let s = start_with(&["read"], |c| {
        c.max_in_flight = 2;
        c.max_lookups = 1;
    })
    .await;
    let body = json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}});
    let reqs: Vec<_> = (0..20)
        .map(|_| {
            let (url, token, body) = (s.url.clone(), s.token.clone(), body.clone());
            tokio::spawn(async move { post(&url, Some(&token), body).await.status() })
        })
        .collect();
    for h in reqs {
        assert_eq!(h.await.unwrap(), 200);
    }
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

#[tokio::test]
async fn revoking_a_token_drops_it_from_the_known_token_cache() {
    let s = start(&["read"], 100).await;
    let body = json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}});
    assert_eq!(
        post(&s.url, Some(&s.token), body.clone()).await.status(),
        200
    );
    let hash = coauthor_lib::agents::hash_token(&s.token);
    assert!(s.store.is_known_token_hash(&hash));
    let agent = &s.store.list_agents().unwrap()[0];
    let tok = &s.store.list_tokens(&agent.id).unwrap()[0];
    s.store.revoke_token(&tok.id).unwrap();
    assert!(!s.store.is_known_token_hash(&hash));
    assert_eq!(post(&s.url, Some(&s.token), body).await.status(), 401);
}

#[tokio::test]
async fn revoking_an_agent_drops_its_tokens_from_the_cache() {
    let s = start(&["read"], 100).await;
    let body = json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}});
    assert_eq!(post(&s.url, Some(&s.token), body).await.status(), 200);
    let hash = coauthor_lib::agents::hash_token(&s.token);
    let agent = &s.store.list_agents().unwrap()[0];
    s.store.revoke_agent(&agent.id).unwrap();
    assert!(!s.store.is_known_token_hash(&hash));
}

#[tokio::test]
async fn saturated_semaphores_time_out_with_503() {
    let s = start_with(&["read"], |c| {
        c.rate_limit = 1000;
        c.max_in_flight = 1;
        c.max_lookups = 1;
        c.in_flight_timeout = std::time::Duration::from_millis(1);
        c.lookup_timeout = std::time::Duration::from_millis(1);
    })
    .await;
    let body = json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}});
    let reqs: Vec<_> = (0..40)
        .map(|_| {
            let (url, token, body) = (s.url.clone(), s.token.clone(), body.clone());
            tokio::spawn(async move { post(&url, Some(&token), body).await })
        })
        .collect();
    let (mut ok, mut busy) = (0, 0);
    for h in reqs {
        let r = h.await.unwrap();
        match r.status().as_u16() {
            200 => ok += 1,
            503 => {
                assert_eq!(r.headers()["retry-after"], "1");
                busy += 1;
            }
            other => panic!("unexpected status {other}"),
        }
    }
    assert!(ok >= 1, "some requests get through");
    assert!(
        busy >= 1,
        "a saturated gate answers 503 instead of queueing forever"
    );
}

#[tokio::test]
async fn cached_token_revoked_out_of_band_gets_401() {
    let s = start(&["read"], 100).await;
    let body = json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}});
    assert_eq!(
        post(&s.url, Some(&s.token), body.clone()).await.status(),
        200
    );
    let hash = coauthor_lib::agents::hash_token(&s.token);
    assert!(s.store.is_known_token_hash(&hash));
    // Bypass the revoke API, as a restore would.
    let db = rusqlite::Connection::open(s.store.data_dir().join("coauthor.db")).unwrap();
    db.execute("UPDATE agent_tokens SET revoked_at = 'x'", [])
        .unwrap();
    assert_eq!(post(&s.url, Some(&s.token), body).await.status(), 401);
    assert!(
        !s.store.is_known_token_hash(&hash),
        "a failed lookup evicts the hash"
    );
    s.store.remember_token_hash(hash.clone());
    s.store.clear_token_cache();
    assert!(!s.store.is_known_token_hash(&hash));

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

#[tokio::test]
async fn cached_token_is_rejected_after_a_restore() {
    let s = start(&["read"], 100).await;
    let body = json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}});
    assert_eq!(
        post(&s.url, Some(&s.token), body.clone()).await.status(),
        200
    );
    let hash = coauthor_lib::agents::hash_token(&s.token);
    assert!(s.store.is_known_token_hash(&hash), "token is cached");
    let zip = s.store.data_dir().join("synthetic-backup.zip");
    coauthor_lib::backup::create_backup_to(&s.store, "0.0.0", &zip, false).unwrap();
    let report = coauthor_lib::backup::restore_backup(&s.store, "0.0.0", &zip).unwrap();
    assert!(report.tokens_revoked >= 1);
    assert!(
        !s.store.is_known_token_hash(&hash),
        "restore clears the token cache"
    );
    assert_eq!(post(&s.url, Some(&s.token), body).await.status(), 401);
}
