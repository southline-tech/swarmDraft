//! RAD-264: writes made over MCP reach an open editor without a reload. The editor loads a
//! manuscript (with its `updates_cursor`), an agent suggests and comments over MCP, and
//! `updates_since` hands the editor exactly those updates. Synthetic text only.
//!
//! With `COAUTHOR_WRITE_LIVE_FIXTURE=1` the loaded manuscript and the agent's updates are written
//! to `fixtures/mcp/live-agent-updates.json`, which the desktop app's live-update test replays
//! into a mounted editor.

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
    let (app, _) = mcp::router_with_stats(store.clone(), mcp::McpConfig::new(addr.port()));
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
    let js = call(
        &s,
        "read_chapter",
        json!({"manuscript_id": mid, "section_id": section.section.id, "format": "json"}),
    )
    .await;
    let bid = js["blocks"][1]["id"].as_str().unwrap().to_string();
    call(&s, "suggest_edit", json!({"manuscript_id": mid, "section_id": section.section.id, "block_id": bid, "quote": "flickered", "replacement": "guttered"})).await;
    call(&s, "add_comment", json!({"manuscript_id": mid, "section_id": section.section.id, "block_id": bid, "quote": "lantern", "body": "Which lantern?"})).await;
    // A write to another manuscript is not this editor's business.
    let o = s.store.load_manuscript(&other).unwrap();
    s.store
        .append_doc_update(
            &o.sections[0].section.doc_id,
            &state(&coauthor_lib::content::new_doc()),
        )
        .unwrap();

    let live = s.store.updates_since(&mid, opened.updates_cursor).unwrap();
    assert_eq!(live.updates.len(), 2, "one update per MCP write");
    assert!(live
        .updates
        .iter()
        .all(|u| u.doc_id == section.section.doc_id));
    assert!(live.cursor > opened.updates_cursor);
    assert!(s
        .store
        .updates_since(&mid, live.cursor)
        .unwrap()
        .updates
        .is_empty());

    // Applying them to the editor's copy yields exactly the stored document.
    let editor = coauthor_lib::content::new_doc();
    {
        let mut t = editor.transact_mut();
        t.apply_update(Update::decode_v1(&section.state).unwrap())
            .unwrap();
        for u in &live.updates {
            t.apply_update(Update::decode_v1(&u.update).unwrap())
                .unwrap();
        }
    }
    let stored = s.store.load_doc(&section.section.doc_id).unwrap();
    assert_eq!(
        editor.transact().state_vector(),
        stored.transact().state_vector()
    );

    if std::env::var_os("COAUTHOR_WRITE_LIVE_FIXTURE").is_some() {
        let out = json!({
            "_note": "Generated by src-tauri/tests/live_updates.rs (COAUTHOR_WRITE_LIVE_FIXTURE=1). Synthetic text.",
            "stored": opened,
            "live": live,
        });
        std::fs::write(FIXTURE_OUT, serde_json::to_string(&out).unwrap() + "\n").unwrap();
    }
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
