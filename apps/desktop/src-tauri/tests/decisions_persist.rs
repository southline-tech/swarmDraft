//! #51: review decision records persist with the manuscript and survive reopening the database.
//! #162: saving decisions keeps the suggestions index in step with the document.

use coauthor_lib::{
    manuscripts::{Author, ImportSection, ReviewDecisionRecord, Suggestion},
    storage::Store,
};
use serde_json::json;
use yrs::{ReadTxn, StateVector, Transact};

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

fn bot_suggestion(section_id: &str, id: &str) -> Suggestion {
    Suggestion {
        id: id.into(),
        section_id: section_id.into(),
        block_id: None,
        kind: "replace".into(),
        quote: Some("old".into()),
        replacement: Some("new".into()),
        rationale: Some("Stronger verb.".into()),
        author: Author {
            kind: "agent".into(),
            id: "a1".into(),
            name: "Kim".into(),
        },
        status: "open".into(),
        created_at: "2026-01-01T00:00:00.000Z".into(),
    }
}

fn accepted_insert(id: &str) -> ReviewDecisionRecord {
    ReviewDecisionRecord {
        kind: "suggestion_insert".into(),
        id: id.into(),
        status: "accepted".into(),
        decided_at: "2026-10-26T03:00:00.000Z".into(),
        decided_by: "author".into(),
    }
}

fn rejected_insert(id: &str) -> ReviewDecisionRecord {
    ReviewDecisionRecord {
        kind: "suggestion_insert".into(),
        id: id.into(),
        status: "rejected".into(),
        decided_at: "2026-10-26T03:00:00.000Z".into(),
        decided_by: "author".into(),
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
fn saving_decisions_closes_matching_suggestions_and_undo_reopens() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(tmp.path()).unwrap();
    let (m, secs) = store
        .import_manuscript("Synthetic Harbor", &[sec("c1", "Chapter One")])
        .unwrap();
    let sid = secs[0].id.clone();
    store
        .insert_suggestion(&m.id, &bot_suggestion(&sid, "s1"))
        .unwrap();
    assert_eq!(store.open_suggestions(&sid).unwrap().len(), 1);
    store
        .save_section_review_decisions(&m.id, &sid, &[accepted_insert("s1")])
        .unwrap();
    assert!(store.open_suggestions(&sid).unwrap().is_empty());
    let row = store.get_suggestion("s1").unwrap().unwrap();
    assert_eq!(row.status, "accepted");
    store
        .save_section_review_decisions(&m.id, &sid, &[])
        .unwrap();
    assert_eq!(store.open_suggestions(&sid).unwrap().len(), 1);
    assert_eq!(store.get_suggestion("s1").unwrap().unwrap().status, "open");
}

#[test]
fn saving_decisions_reject_closes_matching_suggestions() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(tmp.path()).unwrap();
    let (m, secs) = store
        .import_manuscript("Synthetic Harbor", &[sec("c1", "Chapter One")])
        .unwrap();
    let sid = secs[0].id.clone();
    store
        .insert_suggestion(&m.id, &bot_suggestion(&sid, "s1"))
        .unwrap();
    assert_eq!(store.open_suggestions(&sid).unwrap().len(), 1);
    store
        .save_section_review_decisions(&m.id, &sid, &[rejected_insert("s1")])
        .unwrap();
    assert!(store.open_suggestions(&sid).unwrap().is_empty());
    let row = store.get_suggestion("s1").unwrap().unwrap();
    assert_eq!(row.status, "rejected");
}

#[test]
fn accepted_suggestions_drop_from_open_meta_rationales() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(tmp.path()).unwrap();
    let (m, secs) = store
        .import_manuscript("Synthetic Harbor", &[sec("c1", "Chapter One")])
        .unwrap();
    let sid = secs[0].id.clone();
    store
        .insert_suggestion(&m.id, &bot_suggestion(&sid, "s1"))
        .unwrap();
    let open_before = store.open_suggestions(&sid).unwrap();
    assert_eq!(open_before.len(), 1);
    assert_eq!(open_before[0].rationale.as_deref(), Some("Stronger verb."));
    store
        .save_section_review_decisions(&m.id, &sid, &[accepted_insert("s1")])
        .unwrap();
    let open = store.open_suggestions(&sid).unwrap();
    assert!(open.is_empty());
    let mut reasons = std::collections::HashMap::new();
    for sug in open {
        if let Some(r) = sug.rationale.as_ref().filter(|s| !s.is_empty()) {
            reasons.insert(sug.id.clone(), r.clone());
        }
    }
    assert!(!reasons.contains_key("s1"));
}

#[test]
fn section_save_upserts_human_suggestion_marks_into_index() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(tmp.path()).unwrap();
    let m = store.create_manuscript("Synthetic Harbor").unwrap();
    let pm = json!({"type":"doc","content":[{"type":"paragraph","attrs":{"style":"body"},
        "content":[{"type":"text","text":"tracked","marks":[{"type":"suggestion_insert",
            "attrs":{"id":"h1","author":"Alex","ts":"2026-01-01T00:00:00.000Z"}}]}]}]});
    let sec = store
        .import_section_json(&m.id, "chapter", "One", &pm)
        .unwrap();
    let doc = store.load_doc(&sec.doc_id).unwrap();
    let update = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    store.apply_section_update(&m.id, &sec.id, &update).unwrap();
    let open = store.open_suggestions(&sec.id).unwrap();
    assert_eq!(open.len(), 1);
    assert_eq!(open[0].id, "h1");
    assert_eq!(open[0].author.kind, "human");
    assert_eq!(open[0].author.name, "Alex");
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
