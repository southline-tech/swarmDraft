//! Git-backed `.draft` file (#302, partial #116).

use std::fs;
use std::path::Path;

use swarmdraft_lib::draft::{
    pack_draft, unpack_draft, DraftManifest, DraftService, DRAFT_FORMAT, DRAFT_FORMAT_VERSION,
};
use swarmdraft_lib::storage::Store;
use tempfile::tempdir;

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
