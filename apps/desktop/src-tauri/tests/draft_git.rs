//! Git-backed `.draft` file (#302, partial #116).

use std::fs;
use std::path::Path;

use serde_json::json;
use swarmdraft_lib::content::{self, decode};
use swarmdraft_lib::draft::{
    pack_draft, unpack_draft, DraftManifest, DraftService, DRAFT_FORMAT, DRAFT_FORMAT_VERSION,
};
use swarmdraft_lib::storage::Store;
use tempfile::tempdir;
use yrs::{ReadTxn, StateVector, Transact};

fn temp_store() -> (tempfile::TempDir, Store) {
    let dir = tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    (dir, store)
}

#[test]
fn commit_on_save_checkpoint_and_round_trip() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript;
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.1.1".into());
    let drafts_dir = store.data_dir().join("drafts");
    let oid = svc
        .commit_now(
            &store,
            &m.id,
            "Edited Chapter One",
            "Author",
            "author@swarmdraft.local",
        )
        .unwrap_or_else(|e| panic!("commit_now: {e}"))
        .expect("commit oid");
    assert!(!oid.is_empty());
    store
        .set_draft_file_path(&m.id, &drafts_dir.join("a.draft").to_string_lossy())
        .unwrap();
    svc.pack_if_linked(&store, &m.id).unwrap();
    let path = store.draft_file_path(&m.id).unwrap().unwrap();
    assert!(Path::new(&path).is_file());
    let work2 = tempdir().unwrap();
    let manifest = unpack_draft(Path::new(&path), work2.path()).unwrap();
    assert_eq!(manifest.format, DRAFT_FORMAT);
    assert_eq!(manifest.format_version, DRAFT_FORMAT_VERSION);
    assert_eq!(manifest.book_id, m.id);
}

#[test]
fn restore_creates_new_commit_without_deleting_history() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript;
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.1.1".into());
    store
        .set_draft_file_path(
            &m.id,
            &store
                .data_dir()
                .join("drafts/restore.draft")
                .to_string_lossy(),
        )
        .unwrap();
    svc.commit_now(&store, &m.id, "First", "Author", "author@swarmdraft.local")
        .unwrap_or_else(|e| panic!("first commit: {e}"));
    let first = svc.history(&store, &m.id, 1, 0).unwrap()[0].oid.clone();
    svc.commit_now(&store, &m.id, "Second", "Author", "author@swarmdraft.local")
        .unwrap();
    let new_oid = svc.restore(&store, &m.id, &first, "Author").unwrap();
    assert!(!new_oid.is_empty());
    let history = svc.history(&store, &m.id, 10, 0).unwrap();
    assert!(history.len() >= 3);
    assert!(history
        .iter()
        .any(|c| c.message.contains("Restored version")));
}

#[test]
fn migration_creates_draft_for_legacy_book() {
    let (_dir, store) = temp_store();
    let _m = store.create_blank_manuscript_with_progress(None).unwrap();
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.1.1".into());
    let drafts_dir = store.data_dir().join("drafts");
    let notices =
        swarmdraft_lib::draft::migrate_legacy_books_to_draft(&store, &svc, &drafts_dir).unwrap();
    assert_eq!(notices.len(), 1);
    assert!(Path::new(&notices[0].draft_path).is_file());
}

#[test]
fn hydrate_open_draft_loads_git_chapter_text() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript;
    let chapter = stored
        .sections
        .iter()
        .find(|s| s.section.kind == "chapter")
        .unwrap();
    let marker = "Portable git marker xyzzy";
    set_chapter_plain(&store, &chapter.section.doc_id, marker);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.1.1".into());
    let draft_path = store.data_dir().join("drafts/portable.draft");
    store
        .set_draft_file_path(&m.id, &draft_path.to_string_lossy())
        .unwrap();
    svc.commit_now(
        &store,
        &m.id,
        "Tagged for portable open",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap();
    // Stale SQLite: editor would show wrong text without hydrate on open.
    set_chapter_plain(&store, &chapter.section.doc_id, "stale local only");
    assert!(chapter_text(&store, &chapter.section.doc_id).contains("stale local only"));
    let opened = svc
        .open_draft_path(&store, &draft_path.to_string_lossy())
        .unwrap()
        .expect("manuscript id");
    assert_eq!(opened, m.id);
    assert!(chapter_text(&store, &chapter.section.doc_id).contains(marker));
    assert!(!chapter_text(&store, &chapter.section.doc_id).contains("stale local only"));
}

#[test]
fn restore_hydrates_sqlite_from_git() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript;
    let chapter = stored
        .sections
        .iter()
        .find(|s| s.section.kind == "chapter")
        .unwrap();
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.1.1".into());
    store
        .set_draft_file_path(
            &m.id,
            &store
                .data_dir()
                .join("drafts/restore-hydrate.draft")
                .to_string_lossy(),
        )
        .unwrap();
    set_chapter_plain(&store, &chapter.section.doc_id, "version-one");
    svc.commit_now(&store, &m.id, "First", "Author", "author@swarmdraft.local")
        .unwrap();
    let first = svc.history(&store, &m.id, 1, 0).unwrap()[0].oid.clone();
    set_chapter_plain(&store, &chapter.section.doc_id, "version-two");
    svc.commit_now(&store, &m.id, "Second", "Author", "author@swarmdraft.local")
        .unwrap();
    set_chapter_plain(&store, &chapter.section.doc_id, "version-two");
    assert!(chapter_text(&store, &chapter.section.doc_id).contains("version-two"));
    svc.restore(&store, &m.id, &first, "Author").unwrap();
    assert!(chapter_text(&store, &chapter.section.doc_id).contains("version-one"));
    assert!(!chapter_text(&store, &chapter.section.doc_id).contains("version-two"));
}

#[test]
fn review_commit_uses_bot_as_git_committer() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript;
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.1.1".into());
    store
        .set_draft_file_path(
            &m.id,
            &store
                .data_dir()
                .join("drafts/bot-commit.draft")
                .to_string_lossy(),
        )
        .unwrap();
    svc.commit_now(
        &store,
        &m.id,
        "Baseline",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap();
    svc.commit_review_decision(
        &store,
        &m.id,
        true,
        "Line Editor",
        "New chapter",
        "Author Name",
    )
    .unwrap();
    let entry = svc
        .history(&store, &m.id, 5, 0)
        .unwrap()
        .into_iter()
        .find(|c| c.message.contains("Accepted Line Editor"))
        .expect("review commit");
    assert_eq!(entry.committer_name, "Line Editor");
}

fn set_chapter_plain(store: &Store, doc_id: &str, text: &str) {
    let doc = content::new_doc();
    content::encode(
        &doc,
        &json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text": text}]}]}),
    )
    .unwrap();
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    store.replace_doc_state(doc_id, &state).unwrap();
}

fn chapter_text(store: &Store, doc_id: &str) -> String {
    let doc = store.load_doc(doc_id).unwrap();
    content::markdown(&decode(&doc))
}

#[test]
fn atomic_pack_survives_replace() {
    let dir = tempdir().unwrap();
    let repo = dir.path().join("repo.git");
    fs::create_dir_all(repo.join("objects")).unwrap();
    fs::write(repo.join("HEAD"), "ref: refs/heads/main\n").unwrap();
    let manifest = DraftManifest {
        format: DRAFT_FORMAT.into(),
        format_version: DRAFT_FORMAT_VERSION,
        app_version: "0.1.1".into(),
        book_id: "x".into(),
        title: "T".into(),
    };
    let draft = dir.path().join("book.draft");
    pack_draft(&draft, &manifest, &repo).unwrap();
    let before = fs::read(&draft).unwrap();
    pack_draft(&draft, &manifest, &repo).unwrap();
    let after = fs::read(&draft).unwrap();
    assert!(!before.is_empty());
    assert!(!after.is_empty());
}
