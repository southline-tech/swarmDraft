//! A bot suggestion must stay visible when the writer reopens the `.draft` that is
//! already open, before the next explicit Save. The bot branch only lives in the
//! working repo until Save packs the file, so reopening must not throw it away.

use std::fs;
use std::path::Path;

use serde_json::json;
use swarmdraft_lib::content::{self, decode};
use swarmdraft_lib::draft::{BotRetention, DraftRepo, DraftService};
use swarmdraft_lib::manuscripts::{doc_update_since, state_vector};
use swarmdraft_lib::storage::Store;
use yrs::{ReadTxn, StateVector, Transact};

const BOT_ID: &str = "agent-test-1";
const BOT_NAME: &str = "Line Editor";
const CHANGE_ID: &str = "chg-reopen";

fn chapter_doc_id(store: &Store, manuscript_id: &str) -> String {
    store
        .list_sections(manuscript_id)
        .unwrap()
        .into_iter()
        .find(|s| s.kind == "chapter")
        .expect("chapter")
        .doc_id
}

/// Review marks are what the editor's review panel reads from the chapter doc.
fn chapter_marks(store: &Store, doc_id: &str) -> String {
    let doc = store.load_doc(doc_id).unwrap();
    decode(&doc)
        .iter()
        .map(|b| b.node.to_string())
        .collect::<Vec<_>>()
        .join("\n")
}

fn has_open_suggestion(store: &Store, doc_id: &str) -> bool {
    let marks = chapter_marks(store, doc_id);
    marks.contains(CHANGE_ID) && marks.contains("suggestion_insert")
}

fn bot_tips(repo: &DraftRepo) -> Vec<String> {
    repo.search_ref_tips()
        .unwrap()
        .into_iter()
        .filter(|t| t.name.starts_with("bot/"))
        .map(|t| t.name)
        .collect()
}

/// Same shape as `suggest_edit`: save the mark through `record_bot_write`, then
/// commit it on the bot branch.
fn bot_suggests(svc: &DraftService, store: &Store, manuscript_id: &str, doc_id: &str) {
    let doc = store.load_doc(doc_id).unwrap();
    let since = state_vector(&doc);
    content::encode(
        &doc,
        &json!({"type":"doc","content":[{"type":"paragraph","content":[
            {"type":"text","text":"The door "},
            {"type":"text","text":"cracked","marks":[{"type":"suggestion_delete","attrs":{"id":CHANGE_ID,"author":format!("agent:{BOT_ID}"),"ts":"t"}}]},
            {"type":"text","text":"creaked","marks":[{"type":"suggestion_insert","attrs":{"id":CHANGE_ID,"author":format!("agent:{BOT_ID}"),"ts":"t"}}]},
            {"type":"text","text":" open."}
        ]}]}),
    )
    .unwrap();
    let update = doc_update_since(&doc, &since);
    svc.record_bot_write(
        store,
        manuscript_id,
        BotRetention {
            comment: None,
            doc_id: Some(doc_id.to_string()),
            doc_update: Some(update.clone()),
        },
        || {
            store
                .append_doc_update(doc_id, &update)
                .map_err(|e| e.to_string())
        },
    )
    .unwrap();
    svc.commit_bot_suggestion(store, manuscript_id, BOT_ID, BOT_NAME, "Bot suggestions")
        .unwrap();
}

#[test]
fn reopening_the_open_draft_keeps_an_unsaved_bot_suggestion() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().to_path_buf();
    let store = Store::open(&data).unwrap();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let doc_id = chapter_doc_id(&store, &m.id);
    let svc = DraftService::new(data.clone(), "0.2.1".into());

    // The writer has a saved `.draft` (Save packs it).
    let path = data.join("drafts").join("test manuscript.draft");
    store
        .set_draft_file_path(&m.id, &path.to_string_lossy())
        .unwrap();
    {
        let doc = content::new_doc();
        content::encode(
            &doc,
            &json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"The door cracked open."}]}]}),
        )
        .unwrap();
        let state = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        store.replace_doc_state(&doc_id, &state).unwrap();
    }
    svc.save_linked_or_needs_as(&store, &m.id, "Saved").unwrap();
    svc.pack_if_linked(&store, &m.id).unwrap();
    let path = path.to_string_lossy().into_owned();
    assert!(Path::new(&path).is_file(), "baseline pack");

    // A bot suggests an edit. Its commit lands on `bot/*`; the file is not repacked.
    bot_suggests(&svc, &store, &m.id, &doc_id);
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    assert_eq!(bot_tips(&repo).len(), 1, "suggestion is on a bot/* branch");
    assert!(
        has_open_suggestion(&store, &doc_id),
        "editor sees the suggestion"
    );

    // The writer opens the same file again (File > Open) before saving.
    let opened = svc
        .open_draft_path(&store, &path, false)
        .unwrap()
        .expect("opened");
    assert_eq!(opened.manuscript_id, m.id);
    assert!(
        opened.recovery.is_none(),
        "nothing on disk is lost, so no recovery prompt"
    );
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    assert_eq!(bot_tips(&repo).len(), 1, "reopen dropped the bot branch");
    assert!(
        has_open_suggestion(&store, &doc_id),
        "reopen dropped the bot suggestion marks: {}",
        chapter_marks(&store, &doc_id)
    );

    // A later bot suggestion still commits on the bot branch.
    svc.commit_bot_suggestion(&store, &m.id, BOT_ID, BOT_NAME, "Bot suggestions")
        .unwrap();
    assert!(svc
        .bot_branch_exists(&store, &m.id, BOT_ID, BOT_NAME)
        .unwrap());

    // Save, close, and reopen from the file with an empty cache.
    svc.save_linked_or_needs_as(&store, &m.id, "Saved").unwrap();
    svc.pack_if_linked(&store, &m.id).unwrap();
    let main = repo.head_oid().unwrap().unwrap();
    let changes = repo
        .file_bytes(&main, "review/changes.json")
        .unwrap()
        .map(|b| String::from_utf8(b).unwrap())
        .unwrap_or_default();
    assert!(
        !changes.contains(CHANGE_ID),
        "an open bot suggestion stays off main until its branch merges: {changes}"
    );
    drop(store);
    drop(svc);
    for name in ["swarmdraft.db", "swarmdraft.db-wal", "swarmdraft.db-shm"] {
        let p = data.join(name);
        if p.exists() {
            fs::remove_file(&p).unwrap();
        }
    }
    fs::remove_dir_all(data.join("draft-repos")).unwrap();
    let store = Store::open(&data).unwrap();
    let svc = DraftService::new(data.clone(), "0.2.1".into());
    let reopened = svc
        .open_draft_path(&store, &path, false)
        .unwrap()
        .expect("reopened");
    assert!(reopened.recovery.is_none());
    let doc_id = chapter_doc_id(&store, &reopened.manuscript_id);
    assert!(
        has_open_suggestion(&store, &doc_id),
        "save, close, reopen dropped the bot suggestion: {}",
        chapter_marks(&store, &doc_id)
    );
    let repo = DraftRepo::open_working(&svc.worktree_path(&reopened.manuscript_id)).unwrap();
    assert_eq!(bot_tips(&repo).len(), 1, "packed file keeps the bot branch");
}

#[test]
fn bot_keeps_committing_after_the_writer_discards_newer_local_work() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().to_path_buf();
    let store = Store::open(&data).unwrap();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let doc_id = chapter_doc_id(&store, &m.id);
    let svc = DraftService::new(data.clone(), "0.2.1".into());
    let path = data.join("drafts").join("test manuscript.draft");
    store
        .set_draft_file_path(&m.id, &path.to_string_lossy())
        .unwrap();
    svc.save_linked_or_needs_as(&store, &m.id, "Saved").unwrap();
    svc.pack_if_linked(&store, &m.id).unwrap();
    let path = path.to_string_lossy().into_owned();

    bot_suggests(&svc, &store, &m.id, &doc_id);
    // A main checkpoint after the pack makes the working repo newer than the file.
    svc.checkpoint_if_due(&store, &m.id, "Edited chapter", true)
        .unwrap();
    let offered = svc.open_draft_path(&store, &path, false).unwrap().unwrap();
    assert!(offered.recovery.is_some(), "newer local work is offered");
    // The writer declines; the working repo is rebuilt from the file.
    svc.open_draft_path(&store, &path, true).unwrap().unwrap();

    // The bot's next suggestion must still land on its branch.
    let doc = store.load_doc(&doc_id).unwrap();
    let since = state_vector(&doc);
    content::encode(
        &doc,
        &json!({"type":"doc","content":[{"type":"paragraph","content":[
            {"type":"text","text":"again","marks":[{"type":"suggestion_insert","attrs":{"id":"chg-after","author":format!("agent:{BOT_ID}"),"ts":"t"}}]}
        ]}]}),
    )
    .unwrap();
    let update = doc_update_since(&doc, &since);
    svc.record_bot_write(
        &store,
        &m.id,
        BotRetention {
            comment: None,
            doc_id: Some(doc_id.clone()),
            doc_update: Some(update.clone()),
        },
        || {
            store
                .append_doc_update(&doc_id, &update)
                .map_err(|e| e.to_string())
        },
    )
    .unwrap();
    svc.commit_bot_suggestion(&store, &m.id, BOT_ID, BOT_NAME, "Bot suggestions")
        .expect("bot commit after the repo was rebuilt");
    assert!(svc
        .bot_branch_exists(&store, &m.id, BOT_ID, BOT_NAME)
        .unwrap());
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let tip = repo.branch_target(&bot_tips(&repo)[0]).unwrap().unwrap();
    let files = repo.list_tree_files(&tip, "review/").unwrap();
    assert!(!files.is_empty(), "bot commit wrote review state");
}
