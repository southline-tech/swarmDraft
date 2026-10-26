//! An imported manuscript is persisted at once: the MCP server lists it and it survives a
//! restart (reopening the Store). Synthetic text only.

use coauthor_lib::{manuscripts::ImportSection, mcp, storage::Store};
use serde_json::{json, Value};

fn para(t: &str) -> Value {
    json!({"type":"doc","content":[{"type":"paragraph","attrs":{"style":"body"},"content":[{"type":"text","text":t}]}]})
}

fn synthetic_import() -> Vec<ImportSection> {
    vec![
        ImportSection {
            id: None,
            parent_id: None,
            kind: "chapter".into(),
            title: "Chapter One".into(),
            doc: para("A gull circled the quiet harbor."),
        },
        ImportSection {
            id: None,
            parent_id: None,
            kind: "chapter".into(),
            title: "Chapter Two".into(),
            doc: para("Rain tapped on the shutters all night."),
        },
    ]
}

async fn call(url: &str, token: &str, tool: &str, args: Value) -> Value {
    let r = reqwest::Client::new()
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", "2025-06-18")
        .bearer_auth(token)
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":tool,"arguments":args}}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "{tool}");
    let v: Value = r.json().await.unwrap();
    v["result"]["structuredContent"].clone()
}

async fn serve(store: Store) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (app, _) = mcp::router_with_stats(store, mcp::McpConfig::new(addr.port()));
    let app = app.into_make_service_with_connect_info::<std::net::SocketAddr>();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}/mcp")
}

async fn assert_listed(store: Store, token: &str, manuscript_id: &str) {
    let url = serve(store).await;
    let docs = call(&url, token, "list_documents", json!({})).await;
    let docs = docs["documents"].as_array().unwrap();
    assert_eq!(docs.len(), 1, "{docs:?}");
    assert_eq!(docs[0]["title"], "Synthetic Harbor");
    assert_eq!(docs[0]["sectionCount"], 2);
    let ch = call(
        &url,
        token,
        "list_chapters",
        json!({"manuscript_id": manuscript_id}),
    )
    .await;
    let secs = ch["sections"].as_array().unwrap();
    assert_eq!(secs.len(), 2);
    assert_eq!(secs[0]["title"], "Chapter One");
    assert_eq!(secs[1]["title"], "Chapter Two");
    assert!(secs[0]["wordCount"].as_u64().unwrap() > 0);
}

#[tokio::test]
async fn import_is_listed_over_mcp_and_survives_restart() {
    let tmp = tempfile::tempdir().unwrap();
    let (token, id) = {
        let store = Store::open(tmp.path()).unwrap();
        let agent = store.create_agent("Test Agent", "#3366ff").unwrap();
        let token = store
            .create_token(&agent.id, Some(&["read".to_string()]))
            .unwrap()
            .token;
        let (m, secs) = store
            .import_manuscript("Synthetic Harbor", &synthetic_import())
            .unwrap();
        assert_eq!(secs.len(), 2);
        for s in &secs {
            let blocks = coauthor_lib::content::decode(&store.load_doc(&s.doc_id).unwrap());
            assert!(
                !blocks.is_empty(),
                "initial doc state saved for {}",
                s.title
            );
        }
        assert_listed(store, &token, &m.id).await;
        (token, m.id)
    };
    // Restart: a fresh Store on the same data dir sees the same manuscript.
    let store = Store::open(tmp.path()).unwrap();
    assert_listed(store, &token, &id).await;
}

#[test]
fn a_bad_section_writes_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(tmp.path()).unwrap();
    let mut secs = synthetic_import();
    secs.push(ImportSection {
        id: None,
        parent_id: None,
        kind: "chapter".into(),
        title: "Bad".into(),
        doc: json!({"type":"nope"}),
    });
    assert!(store.import_manuscript("Synthetic Harbor", &secs).is_err());
    secs.pop();
    secs.push(ImportSection {
        id: None,
        parent_id: None,
        kind: "epilogue?".into(),
        title: "Bad".into(),
        doc: para("x"),
    });
    assert!(store.import_manuscript("Synthetic Harbor", &secs).is_err());
    assert!(store.list_manuscripts().unwrap().is_empty());
}

fn sec(id: &str, parent: Option<&str>, kind: &str, title: &str) -> ImportSection {
    ImportSection {
        id: Some(id.into()),
        parent_id: parent.map(Into::into),
        kind: kind.into(),
        title: title.into(),
        doc: para(&format!("Synthetic text for {title}.")),
    }
}

#[test]
fn hierarchy_is_kept_and_ids_match_doc_ids() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(tmp.path()).unwrap();
    let input = vec![
        sec("s001", None, "part", "Part One"),
        sec("s002", Some("s001"), "chapter", "Chapter One"),
        sec("s003", Some("s002"), "scene", "Scene One"),
        sec("s004", None, "back_matter", "Afterword"),
    ];
    let (m, secs) = store.import_manuscript("Synthetic Harbor", &input).unwrap();
    assert_eq!(secs[0].parent_id, None);
    assert_eq!(secs[1].parent_id.as_deref(), Some(secs[0].id.as_str()));
    assert_eq!(secs[2].parent_id.as_deref(), Some(secs[1].id.as_str()));
    assert_eq!(secs[3].parent_id, None);
    // What the app opens (and reopens after a restart) is exactly the stored rows.
    drop(store);
    let store = Store::open(tmp.path()).unwrap();
    let loaded = store.latest_manuscript().unwrap().unwrap();
    assert_eq!(loaded.manuscript.id, m.id);
    let rows: Vec<_> = loaded.sections.iter().map(|s| s.section.clone()).collect();
    assert_eq!(rows, secs);
    for s in &loaded.sections {
        assert_eq!(
            s.section.doc_id,
            format!("manuscript/{}/section/{}", m.id, s.section.id)
        );
        // The returned state is the stored content.
        use yrs::updates::decoder::Decode;
        let d = coauthor_lib::content::new_doc();
        yrs::Transact::transact_mut(&d)
            .apply_update(yrs::Update::decode_v1(&s.state).unwrap())
            .unwrap();
        let text = serde_json::to_string(
            &coauthor_lib::content::decode(&d)
                .iter()
                .map(|b| &b.node)
                .collect::<Vec<_>>(),
        )
        .unwrap();
        assert!(
            text.contains(&format!("Synthetic text for {}.", s.section.title)),
            "{text}"
        );
    }
    // A parent that is not an earlier section in the import is refused, writing nothing.
    let bad = vec![
        sec("s002", Some("s001"), "chapter", "Orphan"),
        sec("s001", None, "part", "Late Part"),
    ];
    let fresh = Store::open(tempfile::tempdir().unwrap().path()).unwrap();
    assert!(fresh.import_manuscript("x", &bad).is_err());
    assert!(fresh.list_manuscripts().unwrap().is_empty());
}

/// What the editor does: load the stored state, edit, send the delta.
fn edit_update(state: &[u8], prefix: &str) -> Vec<u8> {
    use yrs::updates::decoder::Decode;
    use yrs::{GetString, ReadTxn, Text, Transact, Update, XmlFragment, XmlOut};
    let doc = coauthor_lib::content::new_doc();
    doc.transact_mut()
        .apply_update(Update::decode_v1(state).unwrap())
        .unwrap();
    let before = doc.transact().state_vector();
    let frag = doc.get_or_insert_xml_fragment(coauthor_lib::content::FRAGMENT);
    let mut txn = doc.transact_mut();
    let Some(XmlOut::Element(p)) = frag.get(&txn, 0) else {
        panic!("no paragraph")
    };
    let Some(XmlOut::Text(t)) = p.get(&txn, 0) else {
        panic!("no text")
    };
    assert!(!t.get_string(&txn).is_empty());
    t.insert(&mut txn, 0, prefix);
    drop(txn);
    let u = doc.transact().encode_state_as_update_v1(&before);
    u
}

#[tokio::test]
async fn editor_edits_are_saved_reopened_and_read_over_mcp() {
    let tmp = tempfile::tempdir().unwrap();
    let (token, id, sec) = {
        let store = Store::open(tmp.path()).unwrap();
        let agent = store.create_agent("Test Agent", "#3366ff").unwrap();
        let token = store
            .create_token(&agent.id, Some(&["read".to_string()]))
            .unwrap()
            .token;
        let (m, _) = store
            .import_manuscript("Synthetic Harbor", &synthetic_import())
            .unwrap();
        let loaded = store.load_manuscript(&m.id).unwrap();
        let s = &loaded.sections[1];
        let u = edit_update(&s.state, "Edited: ");
        store
            .apply_section_update(&m.id, &s.section.id, &u)
            .unwrap();
        // A second edit on top of the first, as a later debounced flush would send.
        let again = store.load_manuscript(&m.id).unwrap();
        let u2 = edit_update(&again.sections[1].state, "Twice ");
        store
            .apply_section_update(&m.id, &s.section.id, &u2)
            .unwrap();
        (token, m.id, s.section.id.clone())
    };
    // Restart: the latest manuscript reopens from the DB with the edits.
    let store = Store::open(tmp.path()).unwrap();
    let latest = store.latest_manuscript().unwrap().expect("reopens");
    assert_eq!(latest.manuscript.id, id);
    let blocks =
        coauthor_lib::content::decode(&store.load_doc(&latest.sections[1].section.doc_id).unwrap());
    let text = serde_json::to_string(&blocks.iter().map(|b| &b.node).collect::<Vec<_>>()).unwrap();
    assert!(text.contains("Twice Edited: Rain tapped"), "{text}");
    let url = serve(store).await;
    let r = call(
        &url,
        &token,
        "read_chapter",
        json!({"manuscript_id": id, "section_id": sec, "format": "json"}),
    )
    .await;
    assert!(r.to_string().contains("Twice Edited: Rain tapped"), "{r}");
}

#[test]
fn malformed_or_foreign_updates_are_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(tmp.path()).unwrap();
    let (m, secs) = store
        .import_manuscript("Synthetic Harbor", &synthetic_import())
        .unwrap();
    assert!(store
        .apply_section_update(&m.id, &secs[0].id, b"not yjs")
        .is_err());
    assert!(store
        .apply_section_update(&m.id, "missing", &[0, 0])
        .is_err());
    assert!(store.latest_manuscript().unwrap().is_some());
    let fresh = Store::open(tempfile::tempdir().unwrap().path()).unwrap();
    assert!(fresh.latest_manuscript().unwrap().is_none());
}

/// After failed saves the editor resends its full state; the store merges it idempotently, so
/// an edit whose delta never arrived (LOST) and a later one (LATER) both survive a restart, and
/// a repeated full state doesn't duplicate anything.
#[test]
fn a_resent_full_state_recovers_lost_edits_idempotently() {
    use yrs::updates::decoder::Decode;
    use yrs::{GetString, ReadTxn, StateVector, Text, Transact, Update, XmlFragment, XmlOut};
    let tmp = tempfile::tempdir().unwrap();
    let (mid, sid, doc_id) = {
        let store = Store::open(tmp.path()).unwrap();
        let (m, _) = store
            .import_manuscript("Synthetic Harbor", &synthetic_import())
            .unwrap();
        let loaded = store.load_manuscript(&m.id).unwrap();
        let s = &loaded.sections[1];
        // The editor's copy: LOST is typed (its save fails, never stored), then LATER.
        let client = coauthor_lib::content::new_doc();
        client
            .transact_mut()
            .apply_update(Update::decode_v1(&s.state).unwrap())
            .unwrap();
        let frag = client.get_or_insert_xml_fragment(coauthor_lib::content::FRAGMENT);
        for word in ["LOST ", "LATER "] {
            let mut txn = client.transact_mut();
            let Some(XmlOut::Element(p)) = frag.get(&txn, 0) else {
                panic!("no paragraph")
            };
            let Some(XmlOut::Text(t)) = p.get(&txn, 0) else {
                panic!("no text")
            };
            t.insert(&mut txn, 0, word);
            assert!(t.get_string(&txn).starts_with(word));
        }
        let full = client
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        store
            .apply_section_update(&m.id, &s.section.id, &full)
            .unwrap();
        // A retry that sends the same full state again changes nothing.
        store
            .apply_section_update(&m.id, &s.section.id, &full)
            .unwrap();
        (m.id, s.section.id.clone(), s.section.doc_id.clone())
    };
    let store = Store::open(tmp.path()).unwrap();
    let blocks = coauthor_lib::content::decode(&store.load_doc(&doc_id).unwrap());
    let text = serde_json::to_string(&blocks.iter().map(|b| &b.node).collect::<Vec<_>>()).unwrap();
    assert!(text.contains("LATER LOST Rain tapped"), "{text}");
    assert_eq!(text.matches("LOST").count(), 1, "{text}");
    let latest = store.latest_manuscript().unwrap().unwrap();
    assert_eq!(latest.manuscript.id, mid);
    assert!(latest.sections.iter().any(|s| s.section.id == sid));
}

#[test]
fn a_rolled_back_import_leaves_the_original_as_latest() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(tmp.path()).unwrap();
    let (orig, _) = store
        .import_manuscript("Original", &synthetic_import())
        .unwrap();
    let (newer, _) = store
        .import_manuscript("Orphan", &synthetic_import())
        .unwrap();
    assert_eq!(
        store.latest_manuscript().unwrap().unwrap().manuscript.id,
        newer.id
    );
    store.delete_manuscript(&newer.id).unwrap();
    store.delete_manuscript(&newer.id).unwrap(); // idempotent
    let store = Store::open(tmp.path()).unwrap(); // relaunch
    let latest = store.latest_manuscript().unwrap().unwrap();
    assert_eq!(latest.manuscript.id, orig.id);
    assert!(latest.sections.iter().all(|s| !s.state.is_empty()));
    assert!(store.load_manuscript(&newer.id).is_err());
}
