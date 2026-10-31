//! RAD-264: writes made over MCP reach an open editor without a reload. The editor loads a
//! manuscript (with its `updates_cursor`), an agent suggests and comments over MCP, and
//! `updates_since` hands the editor exactly those updates. Synthetic text only.
//!
//! With `COAUTHOR_WRITE_LIVE_FIXTURE=1` the loaded manuscript and the agent's updates are written
//! to `fixtures/mcp/live-agent-updates.json`, which the desktop app's live-update test replays
//! into a mounted editor. Without it, the committed fixture is checked against a fresh run
//! (client ids, mark ids and timestamps differ per run, so the decoded documents are compared).

use coauthor_lib::{mcp, storage::Store};
use serde_json::{json, Value};
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

const FIXTURE_OUT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../fixtures/mcp/live-agent-updates.json"
);

struct Server {
    url: String,
    store: Store,
    token: String,
    _tmp: tempfile::TempDir,
}

async fn start() -> Server {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(tmp.path()).unwrap();
    let agent = store.create_agent("Grok Bot", "#3366ff").unwrap();
    let scopes = vec!["read".to_string(), "comment".into(), "suggest".into()];
    let token = store.create_token(&agent.id, Some(&scopes)).unwrap().token;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (app, _) = mcp::router_with_stats(store.clone(), mcp::McpConfig::new(addr.port()), None);
    let app = app.into_make_service_with_connect_info::<std::net::SocketAddr>();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Server {
        url: format!("http://{addr}/mcp"),
        store,
        token,
        _tmp: tmp,
    }
}

async fn call(s: &Server, tool: &str, args: Value) -> Value {
    let r = reqwest::Client::new()
        .post(&s.url)
        .header("Accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", "2025-06-18")
        .bearer_auth(&s.token)
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":tool,"arguments":args}}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "{tool}");
    let v: Value = r.json().await.unwrap();
    assert_ne!(v["result"]["isError"], true, "{v}");
    v["result"]["structuredContent"].clone()
}

fn import(store: &Store, title: &str) -> String {
    let sections: Vec<coauthor_lib::manuscripts::ImportSection> = serde_json::from_value(json!([
        {"kind": "chapter", "title": "Chapter One", "doc": {"type":"doc","content":[
            {"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Chapter One"}]},
            {"type":"paragraph","attrs":{"style":"body"},"content":[{"type":"text","text":"The lantern flickered twice."}]}
        ]}},
        {"kind": "chapter", "title": "Chapter Two", "doc": {"type":"doc","content":[
            {"type":"paragraph","attrs":{"style":"body"},"content":[{"type":"text","text":"The tide went out."}]}
        ]}},
        {"kind": "chapter", "title": "Chapter Three", "doc": {"type":"doc","content":[
            {"type":"paragraph","attrs":{"style":"body"},"content":[{"type":"text","text":"She said naïve café — 😀 twice."}]}
        ]}}
    ]))
    .unwrap();
    store.import_manuscript(title, &sections).unwrap().0.id
}

fn state(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

#[tokio::test]
async fn agent_writes_reach_an_open_editor() {
    let s = start().await;
    let mid = import(&s.store, "Sample Manuscript");
    let other = import(&s.store, "Other Manuscript");

    // The editor opens the manuscript.
    let opened = s.store.load_manuscript(&mid).unwrap();
    let section = &opened.sections[0];
    assert!(opened.updates_cursor > 0);
    assert!(s
        .store
        .updates_since(&mid, opened.updates_cursor)
        .unwrap()
        .updates
        .is_empty());

    // An agent suggests and comments over MCP while it is open.
    let sid = &section.section.id;
    let js = call(
        &s,
        "read_chapter",
        json!({"manuscript_id": mid, "section_id": sid, "format": "json"}),
    )
    .await;
    let bid = js["blocks"][1]["id"].as_str().unwrap().to_string();
    call(&s, "suggest_edit", json!({"manuscript_id": mid, "section_id": sid, "block_id": bid, "quote": "flickered", "replacement": "guttered"})).await;
    call(&s, "add_comment", json!({"manuscript_id": mid, "section_id": sid, "block_id": bid, "quote": "lantern", "body": "Which lantern?"})).await;
    // Non-ASCII: the quote comes from search_text, with UTF-16 offsets as the editor counts them.
    let hits = call(
        &s,
        "search_text",
        json!({"manuscript_id": mid, "query": "café — 😀"}),
    )
    .await;
    let hit = &hits["matches"][0];
    assert_eq!(hit["sectionId"], json!(opened.sections[2].section.id));
    assert_eq!(
        (hit["offset"].as_u64(), hit["length"].as_u64()),
        (Some(15), Some(9))
    );
    assert_eq!(hit["quote"], "café — 😀");
    call(&s, "suggest_edit", json!({"manuscript_id": mid, "section_id": hit["sectionId"], "block_id": hit["blockId"], "quote": hit["quote"], "replacement": "bistro"})).await;
    let three = call(
        &s,
        "read_chapter",
        json!({"manuscript_id": mid, "section_id": hit["sectionId"], "format": "json"}),
    )
    .await;
    assert!(
        three["blocks"][0]["node"]["content"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["text"] == "café — 😀"
                && n["marks"]
                    .as_array()
                    .is_some_and(|m| m.iter().any(|m| m["type"] == "suggestion_delete"))),
        "{three}"
    );
    // MCP can suggest but never decide: no accept/reject tool on this server.
    let tools = list_tools(&s).await;
    assert!(tools.iter().any(|t| t == "suggest_edit"));
    assert!(
        !tools.iter().any(|t| t.contains("accept")
            || t.contains("reject")
            || t.contains("resolve_suggestion")),
        "{tools:?}"
    );
    // A write to another manuscript is not this editor's business.
    let o = s.store.load_manuscript(&other).unwrap();
    s.store
        .append_doc_update(
            &o.sections[0].section.doc_id,
            &state(&coauthor_lib::content::new_doc()),
        )
        .unwrap();

    let live = s.store.updates_since(&mid, opened.updates_cursor).unwrap();
    assert_eq!(live.updates.len(), 3, "one update per MCP write");
    let docs: Vec<&str> = live.updates.iter().map(|u| u.doc_id.as_str()).collect();
    let (a, c) = (&section.section.doc_id, &opened.sections[2].section.doc_id);
    assert_eq!(docs, [a.as_str(), a.as_str(), c.as_str()]);
    assert!(live.cursor > opened.updates_cursor);
    assert!(s
        .store
        .updates_since(&mid, live.cursor)
        .unwrap()
        .updates
        .is_empty());

    // Applying them to the editor's copy yields exactly the stored document, section by section.
    let replayed = replay(&opened, &live);
    for (sec, doc) in opened.sections.iter().zip(&replayed) {
        let stored = s.store.load_doc(&sec.section.doc_id).unwrap();
        assert_eq!(
            doc.transact().state_vector(),
            stored.transact().state_vector()
        );
    }

    let out = json!({
        "_note": "Generated by src-tauri/tests/live_updates.rs (COAUTHOR_WRITE_LIVE_FIXTURE=1). Synthetic text.",
        "stored": opened,
        "live": live,
    });
    if std::env::var_os("COAUTHOR_WRITE_LIVE_FIXTURE").is_some() {
        std::fs::write(FIXTURE_OUT, serde_json::to_string(&out).unwrap() + "\n").unwrap();
    } else {
        // The committed fixture must still be what this generator produces.
        let committed: Value =
            serde_json::from_str(&std::fs::read_to_string(FIXTURE_OUT).unwrap()).unwrap();
        assert_eq!(
            fixture_shape(&committed),
            fixture_shape(&out),
            "fixtures/mcp/live-agent-updates.json is stale; rerun with COAUTHOR_WRITE_LIVE_FIXTURE=1"
        );
    }
}

async fn list_tools(s: &Server) -> Vec<String> {
    let r = reqwest::Client::new()
        .post(&s.url)
        .header("Accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", "2025-06-18")
        .bearer_auth(&s.token)
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}))
        .send()
        .await
        .unwrap();
    let v: Value = r.json().await.unwrap();
    v["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_string())
        .collect()
}

fn bytes(v: &Value) -> Vec<u8> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|b| b.as_u64().unwrap() as u8)
        .collect()
}

fn apply(doc: &Doc, update: &[u8]) {
    doc.transact_mut()
        .apply_update(Update::decode_v1(update).unwrap())
        .unwrap();
}

fn replay(opened: &impl serde::Serialize, live: &impl serde::Serialize) -> Vec<Doc> {
    let (opened, live) = (
        serde_json::to_value(opened).unwrap(),
        serde_json::to_value(live).unwrap(),
    );
    opened["sections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|sec| {
            let doc = coauthor_lib::content::new_doc();
            apply(&doc, &bytes(&sec["state"]));
            for u in live["updates"].as_array().unwrap() {
                if u["docId"] == sec["docId"] {
                    apply(&doc, &bytes(&u["update"]));
                }
            }
            doc
        })
        .collect()
}

/// Run-independent view of a fixture: per section, its title, the decoded document after the
/// live updates, and how many updates it got. Ids and timestamps are dropped.
fn fixture_shape(f: &Value) -> Value {
    fn strip(v: &mut Value) {
        match v {
            Value::Object(m) => {
                for k in ["id", "ts", "createdAt"] {
                    m.remove(k);
                }
                // Agent ids are random per run; keep only that the author is an agent.
                if let Some(Value::String(a)) = m.get_mut("author") {
                    if a.starts_with("agent:") {
                        *a = "agent:".into();
                    }
                }
                m.values_mut().for_each(strip);
            }
            Value::Array(a) => a.iter_mut().for_each(strip),
            _ => {}
        }
    }
    let docs = replay(&f["stored"], &f["live"]);
    let sections = f["stored"]["sections"].as_array().unwrap();
    let ups = f["live"]["updates"].as_array().unwrap();
    let mut out = json!(sections
        .iter()
        .zip(&docs)
        .map(|(sec, doc)| {
            let nodes: Vec<Value> = coauthor_lib::content::decode(doc)
                .into_iter()
                .map(|b| b.node)
                .collect();
            json!({
                "title": sec["title"],
                "kind": sec["kind"],
                "doc": nodes,
                "updates": ups.iter().filter(|u| u["docId"] == sec["docId"]).count(),
            })
        })
        .collect::<Vec<_>>());
    strip(&mut out);
    out
}

#[test]
fn updates_since_pages_and_resumes() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(tmp.path()).unwrap();
    let mid = import(&store, "Paged");
    let m = store.load_manuscript(&mid).unwrap();
    let sec = &m.sections[0].section;
    let total = coauthor_lib::manuscripts::UPDATES_PAGE as usize + 5;
    for _ in 0..total {
        store
            .append_doc_update(&sec.doc_id, &state(&coauthor_lib::content::new_doc()))
            .unwrap();
    }
    let first = store.updates_since(&mid, m.updates_cursor).unwrap();
    assert_eq!(
        first.updates.len(),
        coauthor_lib::manuscripts::UPDATES_PAGE as usize
    );
    let rest = store.updates_since(&mid, first.cursor).unwrap();
    assert_eq!(rest.updates.len(), 5);
}
