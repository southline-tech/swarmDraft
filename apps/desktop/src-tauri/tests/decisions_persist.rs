//! #51: review decision records persist with the manuscript and survive reopening the database.

use coauthor_lib::{
    manuscripts::{ImportSection, ReviewDecisionRecord},
    storage::Store,
};
use serde_json::json;

fn sec(id: &str, title: &str) -> ImportSection {
    ImportSection {
        id: Some(id.into()),
        parent_id: None,
        kind: "chapter".into(),
        title: title.into(),
        doc: json!({"type":"doc","content":[{"type":"paragraph","attrs":{"style":"body"},
            "content":[{"type":"text","text":"Synthetic harbor text."}]}]}),
    }
}

#[test]
fn review_decisions_save_reload_and_replace() {
    let tmp = tempfile::tempdir().unwrap();
    let (mid, sid) = {
        let store = Store::open(tmp.path()).unwrap();
        let (m, secs) = store
            .import_manuscript("Synthetic Harbor", &[sec("c1", "Chapter One")])
            .unwrap();
        let sid = secs[0].id.clone();
        let records = vec![ReviewDecisionRecord {
            kind: "suggestion_insert".into(),
            id: "s1".into(),
            status: "accepted".into(),
            decided_at: "2026-10-26T03:00:00.000Z".into(),
            decided_by: "human:pat".into(),
        }];
        store
            .save_section_review_decisions(&m.id, &sid, &records)
            .unwrap();
        let loaded = store.review_decisions_for_section(&sid).unwrap();
        assert_eq!(loaded, records);
        (m.id, sid)
    };
    let store = Store::open(tmp.path()).unwrap();
    let by_section = store.review_decisions_for_manuscript(&mid).unwrap();
    assert_eq!(
        by_section.get(&sid).map(|v| v.as_slice()),
        Some(
            [ReviewDecisionRecord {
                kind: "suggestion_insert".into(),
                id: "s1".into(),
                status: "accepted".into(),
                decided_at: "2026-10-26T03:00:00.000Z".into(),
                decided_by: "human:pat".into(),
            }]
            .as_slice()
        )
    );
    store
        .save_section_review_decisions(&mid, &sid, &[])
        .unwrap();
    assert!(store.review_decisions_for_section(&sid).unwrap().is_empty());
}

#[test]
fn bad_review_decision_writes_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(tmp.path()).unwrap();
    let (m, secs) = store
        .import_manuscript("Synthetic Harbor", &[sec("c1", "Chapter One")])
        .unwrap();
    let sid = secs[0].id.clone();
    let bad = ReviewDecisionRecord {
        kind: "nope".into(),
        id: "s1".into(),
        status: "accepted".into(),
        decided_at: "2026-10-26T03:00:00.000Z".into(),
        decided_by: "human:pat".into(),
    };
    assert!(store
        .save_section_review_decisions(&m.id, &sid, &[bad])
        .is_err());
    assert!(store.review_decisions_for_section(&sid).unwrap().is_empty());
}
