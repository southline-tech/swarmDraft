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
            kind: "chapter".into(),
            title: "Chapter One".into(),
            doc: para("A gull circled the quiet harbor."),
        },
        ImportSection {
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
        kind: "chapter".into(),
        title: "Bad".into(),
        doc: json!({"type":"nope"}),
    });
    assert!(store.import_manuscript("Synthetic Harbor", &secs).is_err());
    secs.pop();
    secs.push(ImportSection {
        kind: "epilogue?".into(),
        title: "Bad".into(),
        doc: para("x"),
    });
    assert!(store.import_manuscript("Synthetic Harbor", &secs).is_err());
    assert!(store.list_manuscripts().unwrap().is_empty());
}
