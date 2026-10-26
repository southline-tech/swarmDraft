//! RAD-263: outline renames, reorders, moves, adds and deletes are saved to the database,
//! survive a restart, and show in MCP `list_chapters`. Synthetic text only.

use coauthor_lib::{
    manuscripts::{ImportSection, OutlineEntry, Section},
    mcp,
    storage::Store,
};
use serde_json::{json, Value};

fn sec(id: &str, parent: Option<&str>, kind: &str, title: &str) -> ImportSection {
    ImportSection {
        id: Some(id.into()),
        parent_id: parent.map(Into::into),
        kind: kind.into(),
        title: title.into(),
        doc: json!({"type":"doc","content":[{"type":"paragraph","attrs":{"style":"body"},
            "content":[{"type":"text","text":format!("Synthetic text for {title}.")}]}]}),
    }
}

fn entry(s: &Section) -> OutlineEntry {
    OutlineEntry {
        id: s.id.clone(),
        parent_id: s.parent_id.clone(),
        kind: s.kind.clone(),
        title: s.title.clone(),
        doc_id: s.doc_id.clone(),
    }
}

async fn list_chapters(store: Store, token: &str, manuscript_id: &str) -> Vec<Value> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (app, _) = mcp::router_with_stats(store, mcp::McpConfig::new(addr.port()));
    let app = app.into_make_service_with_connect_info::<std::net::SocketAddr>();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let r = reqwest::Client::new()
        .post(format!("http://{addr}/mcp"))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", "2025-06-18")
        .bearer_auth(token)
        .json(
            &json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
            "name":"list_chapters","arguments":{"manuscript_id": manuscript_id}}}),
        )
        .send()
        .await
        .unwrap();
    let v: Value = r.json().await.unwrap();
    v["result"]["structuredContent"]["sections"]
        .as_array()
        .unwrap()
        .clone()
}

#[tokio::test]
async fn outline_edits_persist_across_restart_and_show_over_mcp() {
    let tmp = tempfile::tempdir().unwrap();
    let (token, mid, kept_doc) = {
        let store = Store::open(tmp.path()).unwrap();
        let agent = store.create_agent("Test Agent", "#3366ff").unwrap();
        let token = store
            .create_token(&agent.id, Some(&["read".to_string()]))
            .unwrap()
            .token;
        let (m, secs) = store
            .import_manuscript(
                "Synthetic Harbor",
                &[
                    sec("a", None, "part", "Part One"),
                    sec("b", Some("a"), "chapter", "Chapter One"),
                    sec("c", Some("a"), "chapter", "Chapter Two"),
                    sec("d", None, "chapter", "Doomed"),
                ],
            )
            .unwrap();
        // Rename b, swap b and c, move c out of the part, delete d, add a new chapter.
        let mut b = entry(&secs[1]);
        b.title = "The Gull".into();
        let mut c = entry(&secs[2]);
        c.parent_id = None;
        let new_id = "new-chapter-1".to_string();
        let added = OutlineEntry {
            id: new_id.clone(),
            parent_id: Some(secs[0].id.clone()),
            kind: "chapter".into(),
            title: "Added".into(),
            doc_id: format!("manuscript/{}/section/{new_id}", m.id),
        };
        let out = store
            .save_outline(&m.id, &[c, entry(&secs[0]), added, b])
            .unwrap();
        assert_eq!(
            out.iter().map(|s| s.title.as_str()).collect::<Vec<_>>(),
            ["Chapter Two", "Part One", "Added", "The Gull"]
        );
        // The deleted section's text rows are kept, and the delete is audited.
        let rows = store.load_doc(&secs[3].doc_id).unwrap();
        assert!(!coauthor_lib::content::decode(&rows).is_empty());
        let audit = store.audit_log().unwrap();
        let last = audit.last().unwrap();
        assert_eq!(last.1, "delete_sections");
        assert!(last.3.contains(&secs[3].id), "{}", last.3);
        (token, m.id, secs[1].doc_id.clone())
    };
    let store = Store::open(tmp.path()).unwrap();
    let loaded = store.load_manuscript(&mid).unwrap();
    let rows: Vec<_> = loaded.sections.iter().map(|s| &s.section).collect();
    assert_eq!(rows.len(), 4);
    assert_eq!(rows[0].parent_id, None);
    assert_eq!(rows[2].parent_id.as_deref(), Some(rows[1].id.as_str()));
    assert_eq!(rows[3].parent_id.as_deref(), Some(rows[1].id.as_str()));
    // The renamed section kept its document and text.
    assert_eq!(rows[3].doc_id, kept_doc);
    let blocks = coauthor_lib::content::decode(&store.load_doc(&kept_doc).unwrap());
    assert!(!blocks.is_empty());
    let ch = list_chapters(store, &token, &mid).await;
    let titles: Vec<_> = ch.iter().map(|s| s["title"].as_str().unwrap()).collect();
    assert_eq!(titles, ["Chapter Two", "Part One", "Added", "The Gull"]);
}

#[test]
fn a_bad_outline_writes_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(tmp.path()).unwrap();
    let (m, secs) = store
        .import_manuscript(
            "Synthetic Harbor",
            &[
                sec("a", None, "part", "Part One"),
                sec("b", Some("a"), "chapter", "Chapter One"),
            ],
        )
        .unwrap();
    let before = store.list_sections(&m.id).unwrap();
    let a = entry(&secs[0]);
    let b = entry(&secs[1]);
    // Child before parent.
    assert!(store.save_outline(&m.id, &[b.clone(), a.clone()]).is_err());
    // Duplicate id.
    assert!(store
        .save_outline(&m.id, &[a.clone(), a.clone(), b.clone()])
        .is_err());
    // Unknown kind.
    let mut bad = b.clone();
    bad.kind = "epilogue?".into();
    assert!(store.save_outline(&m.id, &[a.clone(), bad]).is_err());
    // Existing section pointed at another doc.
    let mut swap = b.clone();
    swap.doc_id = a.doc_id.clone();
    assert!(store.save_outline(&m.id, &[a.clone(), swap]).is_err());
    // Bad nesting: a chapter inside a chapter, a scene at the top level.
    let mut nested = b.clone();
    nested.parent_id = None;
    let inner = OutlineEntry {
        id: "y".into(),
        parent_id: Some(b.id.clone()),
        kind: "chapter".into(),
        title: "Y".into(),
        doc_id: format!("manuscript/{}/section/y", m.id),
    };
    assert!(store
        .save_outline(&m.id, &[a.clone(), nested.clone(), inner])
        .is_err());
    let top_scene = OutlineEntry {
        id: "z".into(),
        parent_id: None,
        kind: "scene".into(),
        title: "Z".into(),
        doc_id: format!("manuscript/{}/section/z", m.id),
    };
    assert!(store
        .save_outline(&m.id, &[a.clone(), b.clone(), top_scene])
        .is_err());
    // New section with a foreign doc id.
    let foreign = OutlineEntry {
        id: "x".into(),
        parent_id: None,
        kind: "chapter".into(),
        title: "X".into(),
        doc_id: "manuscript/other/section/x".into(),
    };
    assert!(store.save_outline(&m.id, &[a, b, foreign]).is_err());
    assert_eq!(store.list_sections(&m.id).unwrap(), before);
}
