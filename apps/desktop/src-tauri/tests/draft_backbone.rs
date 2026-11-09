//! Git backbone for sessions, comments, and change history (#116).

use std::fs;
use std::path::Path;

use serde_json::json;
use swarmdraft_lib::content::{self, decode};
use swarmdraft_lib::draft::{
    pack_draft, CommitOptions, DraftChangeResolve, DraftManifest, DraftRepo, DraftService,
    DRAFT_FORMAT, DRAFT_FORMAT_VERSION,
};
use swarmdraft_lib::manuscripts::{Author, Comment, ReviewDecisionRecord};
use swarmdraft_lib::storage::Store;
use yrs::updates::decoder::Decode;
use yrs::{ReadTxn, StateVector, Transact, Update};

fn temp_store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    (dir, store)
}

fn chapter(
    stored: &swarmdraft_lib::manuscripts::StoredManuscript,
) -> &swarmdraft_lib::manuscripts::Section {
    &stored
        .sections
        .iter()
        .find(|s| s.section.kind == "chapter")
        .unwrap()
        .section
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

fn set_chapter_mark(store: &Store, doc_id: &str, change_id: &str, text: &str) {
    let doc = content::new_doc();
    content::encode(
        &doc,
        &json!({"type":"doc","content":[{"type":"paragraph","content":[{
            "type":"text",
            "text": text,
            "marks":[{"type":"suggestion_insert","attrs":{"id": change_id, "author":"agent:bot-1","ts":"t"}}]
        }]}]}),
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

fn link_draft(store: &Store, manuscript_id: &str, name: &str) {
    let path = store.data_dir().join("drafts").join(name);
    store
        .set_draft_file_path(manuscript_id, &path.to_string_lossy())
        .unwrap();
}

struct FoundChange {
    change_id: String,
    status: String,
    introduced_commit: String,
    introduced_ref: String,
    decided_commit: Option<String>,
    decision: Option<String>,
    session_id: Option<String>,
    present_in_head: bool,
}

fn found(result: DraftChangeResolve) -> FoundChange {
    match result {
        DraftChangeResolve::Found {
            change_id,
            status,
            introduced_commit,
            introduced_ref,
            decided_commit,
            decision,
            session_id,
            present_in_head,
            ..
        } => FoundChange {
            change_id,
            status,
            introduced_commit,
            introduced_ref,
            decided_commit,
            decision,
            session_id,
            present_in_head,
        },
        DraftChangeResolve::NotFound { change_id } => panic!("missing change {change_id}"),
    }
}

#[test]
fn editing_session_ref_tracks_commits_and_survives_close() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "session.draft");
    set_chapter_plain(&store, &chapter.doc_id, "base");
    svc.commit_now(
        &store,
        &m.id,
        "Baseline",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap()
    .expect("baseline");
    svc.end_editing_session(&store, &m.id).unwrap();
    let session_id = svc.begin_editing_session(&store, &m.id).unwrap();
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let head = repo.head_oid().unwrap().unwrap();
    assert_eq!(
        repo.branch_target(&format!("session/{session_id}"))
            .unwrap()
            .as_deref(),
        Some(head.as_str())
    );
    let head_name = repo.head_name().unwrap().unwrap();
    assert!(head_name == "main" || head_name == "master");
    let record_path = svc
        .worktree_path(&m.id)
        .join("sessions")
        .join(format!("{session_id}.json"));
    let record: serde_json::Value =
        serde_json::from_slice(&fs::read(&record_path).unwrap()).unwrap();
    assert_eq!(record["id"], session_id);
    assert!(record["endedAt"].is_null());
    assert_eq!(record["baseCommit"].as_str(), Some(head.as_str()));

    set_chapter_plain(&store, &chapter.doc_id, "during session");
    let oid = svc
        .commit_now(
            &store,
            &m.id,
            "Edited chapter",
            "Author",
            "author@swarmdraft.local",
        )
        .unwrap()
        .expect("session commit");
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    assert_eq!(
        repo.branch_target(&format!("session/{session_id}"))
            .unwrap()
            .as_deref(),
        Some(oid.as_str())
    );
    assert_ne!(oid, head);
    let full = repo.commit_message(&oid).unwrap();
    assert!(full.contains(&format!("Session: {session_id}")));
    assert_eq!(full.lines().next(), Some("Edited chapter"));
    let visible = svc.history(&store, &m.id, 1, 0).unwrap();
    assert_eq!(visible[0].message, "Edited chapter");
    assert!(!visible[0].message.contains("Session:"));

    svc.end_editing_session(&store, &m.id).unwrap();
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    assert!(repo
        .branch_target(&format!("session/{session_id}"))
        .unwrap()
        .is_some());
    let tip = repo.head_oid().unwrap().unwrap();
    let bytes = repo
        .file_bytes(&tip, &format!("sessions/{session_id}.json"))
        .unwrap()
        .expect("session record committed");
    let ended: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(ended["endedAt"].is_string());
    let again = svc.begin_editing_session(&store, &m.id).unwrap();
    assert_ne!(again, session_id);
}

#[test]
fn review_commit_trailers_carry_the_change_id() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "review.draft");
    svc.commit_now(
        &store,
        &m.id,
        "Baseline",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap();
    let session_id = svc.begin_editing_session(&store, &m.id).unwrap();
    let chapter = chapter(&stored);
    svc.commit_review_decision(
        &store,
        &m.id,
        true,
        "Line Editor",
        chapter.title.as_str(),
        "Author",
        Some("bot-1"),
        Some("chg-1"),
        Some("suggestion_insert"),
        Some(chapter.id.as_str()),
    )
    .unwrap()
    .expect("one commit per decision");
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let oid = repo.head_oid().unwrap().unwrap();
    let full = repo.commit_message(&oid).unwrap();
    assert!(full.starts_with("Accepted Line Editor's change in "));
    assert!(full.contains("Change-Id: chg-1"));
    assert!(full.contains("Decision: accepted"));
    assert!(full.contains(&format!("Section: {}", chapter.id)));
    assert!(full.contains(&format!("Session: {session_id}")));
    let visible = svc
        .history(&store, &m.id, 5, 0)
        .unwrap()
        .into_iter()
        .find(|c| c.message.contains("Accepted Line Editor"))
        .unwrap();
    assert!(!visible.message.contains("Change-Id"));
    assert!(!visible.message.contains("Session:"));
    assert_eq!(visible.committer_name, "Line Editor");
}

#[test]
fn changes_json_is_byte_stable_when_nothing_changed() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "stable.draft");
    let first = svc
        .commit_now(&store, &m.id, "Saved", "Author", "author@swarmdraft.local")
        .unwrap()
        .expect("first");
    let path = svc.worktree_path(&m.id).join("review/changes.json");
    let bytes = fs::read(&path).unwrap();
    let second = svc
        .commit_now(&store, &m.id, "Saved", "Author", "author@swarmdraft.local")
        .unwrap();
    assert!(second.is_none());
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert_eq!(svc.history(&store, &m.id, 1, 0).unwrap()[0].oid, first);
}

#[test]
fn comment_threads_round_trip_without_duplicates() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "comments.draft");
    let thread = "cthread1".to_string();
    store
        .insert_comment(
            &m.id,
            &Comment {
                id: thread.clone(),
                section_id: chapter.id.clone(),
                block_id: None,
                quote: Some("a line".into()),
                body: "Please check this.".into(),
                thread_id: Some(thread.clone()),
                author: Author {
                    kind: "human".into(),
                    id: "local".into(),
                    name: "Author".into(),
                },
                created_at: "2026-01-01T00:00:00.000Z".into(),
                resolved_at: None,
            },
        )
        .unwrap();
    store
        .human_comment_reply(&m.id, &chapter.id, &thread, "Will do.", "Author", "local")
        .unwrap();
    store
        .set_comment_thread_resolved(&m.id, &chapter.id, &thread, true)
        .unwrap();
    svc.commit_now(&store, &m.id, "Saved", "Author", "author@swarmdraft.local")
        .unwrap();
    let draft_path = store.draft_file_path(&m.id).unwrap().unwrap();
    let thread_file = svc
        .worktree_path(&m.id)
        .join("comments")
        .join(format!("{thread}.json"));
    assert!(thread_file.is_file());

    let dir2 = tempfile::tempdir().unwrap();
    let store2 = Store::open(dir2.path()).unwrap();
    let svc2 = DraftService::new(store2.data_dir().to_path_buf(), "0.2.1".into());
    let opened = svc2
        .open_draft_path(&store2, &draft_path, true)
        .unwrap()
        .unwrap();
    let rows = store2
        .comments_for_manuscript(&opened.manuscript_id)
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|c| c.resolved_at.is_some()));
    svc2.open_draft_path(&store2, &draft_path, true)
        .unwrap()
        .unwrap();
    assert_eq!(
        store2
            .comments_for_manuscript(&opened.manuscript_id)
            .unwrap()
            .len(),
        2
    );
    let section = store2
        .list_sections(&opened.manuscript_id)
        .unwrap()
        .into_iter()
        .find(|s| s.kind == "chapter")
        .unwrap();
    store2
        .insert_comment(
            &opened.manuscript_id,
            &Comment {
                id: "clocalextra".into(),
                section_id: section.id,
                block_id: None,
                quote: None,
                body: "Kept locally.".into(),
                thread_id: Some("clocalextra".into()),
                author: Author {
                    kind: "human".into(),
                    id: "local".into(),
                    name: "Author".into(),
                },
                created_at: "2026-01-03T00:00:00.000Z".into(),
                resolved_at: None,
            },
        )
        .unwrap();
    svc2.open_draft_path(&store2, &draft_path, true)
        .unwrap()
        .unwrap();
    let rows = store2
        .comments_for_manuscript(&opened.manuscript_id)
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows.iter().filter(|c| c.id == "clocalextra").count(), 0);
    assert_eq!(rows.iter().filter(|c| c.id == thread).count(), 1);
}

#[test]
fn resolve_change_finds_introducing_and_deciding_commits() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "resolve.draft");
    svc.commit_now(
        &store,
        &m.id,
        "Baseline",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap();
    set_chapter_mark(&store, &chapter.doc_id, "chg-1", "harbor light");
    let introduced = svc
        .commit_now(
            &store,
            &m.id,
            "Edited chapter",
            "Author",
            "author@swarmdraft.local",
        )
        .unwrap()
        .expect("introducing commit");
    store
        .save_section_review_decisions(
            &m.id,
            &chapter.id,
            &[ReviewDecisionRecord {
                kind: "suggestion_insert".into(),
                id: "chg-1".into(),
                status: "accepted".into(),
                decided_at: "2026-01-02T00:00:00.000Z".into(),
                decided_by: "author".into(),
            }],
        )
        .unwrap();
    let decided = svc
        .commit_review_decision(
            &store,
            &m.id,
            true,
            "Line Editor",
            &chapter.title,
            "Author",
            None,
            Some("chg-1"),
            Some("suggestion_insert"),
            Some(&chapter.id),
        )
        .unwrap()
        .expect("deciding commit");
    assert_ne!(introduced, decided);
    let once = found(svc.resolve_change(&store, &m.id, "chg-1").unwrap());
    let again = found(svc.resolve_change(&store, &m.id, "chg-1").unwrap());
    assert_eq!(once.change_id, "chg-1");
    assert_eq!(once.status, "accepted");
    assert_eq!(once.introduced_commit, introduced);
    assert!(once.introduced_ref == "main" || once.introduced_ref == "master");
    assert_eq!(once.decided_commit.as_deref(), Some(decided.as_str()));
    assert_eq!(once.decision.as_deref(), Some("accepted"));
    assert!(once.session_id.is_some());
    assert!(once.present_in_head);
    assert_eq!(again.introduced_commit, once.introduced_commit);

    let restarted = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    let after = found(restarted.resolve_change(&store, &m.id, "chg-1").unwrap());
    assert_eq!(after.introduced_commit, introduced);
    assert_eq!(after.decided_commit.as_deref(), Some(decided.as_str()));

    match svc.resolve_change(&store, &m.id, "does-not-exist").unwrap() {
        DraftChangeResolve::NotFound { change_id } => assert_eq!(change_id, "does-not-exist"),
        DraftChangeResolve::Found { .. } => panic!("unknown id resolved"),
    }

    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    fs::write(
        svc.worktree_path(&m.id).join("review/changes.json"),
        b"{not json",
    )
    .unwrap();
    repo.commit_all(
        "Corrupt index",
        "Author",
        "author@swarmdraft.local",
        &CommitOptions {
            allow_empty: true,
            advance_branch: None,
        },
    )
    .unwrap();
    let still = found(svc.resolve_change(&store, &m.id, "chg-1").unwrap());
    assert_eq!(still.introduced_commit, introduced);
    match svc
        .resolve_change(&store, &m.id, "only-in-corrupt")
        .unwrap()
    {
        DraftChangeResolve::NotFound { change_id } => assert_eq!(change_id, "only-in-corrupt"),
        other => panic!("corrupt index should not fail resolve: {other:?}"),
    }
}

#[test]
fn checkpoint_commits_yjs_and_live_edit_does_not_wait() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "yjs.draft");
    set_chapter_plain(&store, &chapter.doc_id, "before-checkpoint");
    let before = svc
        .checkpoint_if_due(&store, &m.id, "Edited chapter", false)
        .unwrap()
        .expect("checkpoint");
    set_chapter_plain(&store, &chapter.doc_id, "typed-live");
    assert!(chapter_text(&store, &chapter.doc_id).contains("typed-live"));
    assert_eq!(svc.history(&store, &m.id, 1, 0).unwrap()[0].oid, before);
    let after = svc
        .commit_now(
            &store,
            &m.id,
            "Edited chapter",
            "Author",
            "author@swarmdraft.local",
        )
        .unwrap()
        .expect("checkpoint of the edit");
    assert_ne!(before, after);
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let bytes = repo
        .file_bytes(&after, &format!("yjs/{}.bin", chapter.id))
        .unwrap()
        .expect("yjs blob");
    let doc = content::new_doc();
    let update = Update::decode_v1(&bytes).unwrap();
    doc.transact_mut().apply_update(update).unwrap();
    assert!(content::markdown(&decode(&doc)).contains("typed-live"));
}

#[test]
fn legacy_draft_without_new_dirs_opens_and_sync_adds_them() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "legacy.draft");
    svc.commit_now(
        &store,
        &m.id,
        "Baseline",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap();
    let work = svc.worktree_path(&m.id);
    for name in ["review", "comments", "sessions"] {
        let path = work.join(name);
        if path.exists() {
            fs::remove_dir_all(&path).unwrap();
        }
    }
    DraftRepo::open_working(&work)
        .unwrap()
        .commit_all(
            "Older draft",
            "Author",
            "author@swarmdraft.local",
            &CommitOptions::default(),
        )
        .unwrap()
        .expect("strip commit");
    svc.pack_if_linked(&store, &m.id).unwrap();
    let draft_path = store.draft_file_path(&m.id).unwrap().unwrap();

    let dir2 = tempfile::tempdir().unwrap();
    let store2 = Store::open(dir2.path()).unwrap();
    let svc2 = DraftService::new(store2.data_dir().to_path_buf(), "0.2.1".into());
    let opened = svc2
        .open_draft_path(&store2, &draft_path, true)
        .unwrap()
        .expect("older draft opens");
    let oid = svc2
        .commit_now(
            &store2,
            &opened.manuscript_id,
            "Saved",
            "Author",
            "author@swarmdraft.local",
        )
        .unwrap()
        .expect("first sync adds the new files");
    let repo = DraftRepo::open_working(&svc2.worktree_path(&opened.manuscript_id)).unwrap();
    assert!(repo
        .file_bytes(&oid, "review/changes.json")
        .unwrap()
        .is_some());
    assert!(repo.head_name().unwrap().unwrap() != "session");
}

#[test]
fn bot_branch_stays_on_its_ref_and_main_stays_checked_out() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "bot.draft");
    svc.commit_now(
        &store,
        &m.id,
        "Baseline",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap();
    let bot_id = "agent-test-1";
    svc.commit_bot_suggestion(&store, &m.id, bot_id, "Line Editor", "Bot suggestions")
        .unwrap();
    assert!(svc
        .bot_branch_exists(&store, &m.id, bot_id, "Line Editor")
        .unwrap());
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let head = repo.head_name().unwrap().unwrap();
    assert!(head == "main" || head == "master");
    svc.commit_review_decision(
        &store,
        &m.id,
        true,
        "Line Editor",
        "Chapter",
        "Author",
        Some(bot_id),
        Some("chg-bot"),
        Some("suggestion_insert"),
        Some("section"),
    )
    .unwrap();
    let history = svc.history(&store, &m.id, 10, 0).unwrap();
    assert!(history.iter().any(|c| c.message.starts_with("Merged bot/")));
    assert!(history
        .iter()
        .all(|c| !c.message.contains("Change-Id") && !c.message.contains("Session:")));
}

fn sample_comment(id: &str, section_id: &str, body: &str) -> Comment {
    Comment {
        id: id.into(),
        section_id: section_id.into(),
        block_id: None,
        quote: None,
        body: body.into(),
        thread_id: Some(id.into()),
        author: Author {
            kind: "human".into(),
            id: "local".into(),
            name: "Author".into(),
        },
        created_at: "2026-01-01T00:00:00.000Z".into(),
        resolved_at: None,
    }
}

#[test]
fn accept_all_writes_a_deciding_commit_per_change() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "accept-all.draft");
    svc.commit_now(
        &store,
        &m.id,
        "Baseline",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap();
    let mut records = Vec::new();
    let mut decided = Vec::new();
    for (id, accepted) in [("chg-a", true), ("chg-b", false)] {
        records.push(ReviewDecisionRecord {
            kind: "suggestion_insert".into(),
            id: id.into(),
            status: if accepted { "accepted" } else { "rejected" }.into(),
            decided_at: "2026-01-02T00:00:00.000Z".into(),
            decided_by: "author".into(),
        });
        store
            .save_section_review_decisions(&m.id, &chapter.id, &records)
            .unwrap();
        let oid = svc
            .commit_review_decision(
                &store,
                &m.id,
                accepted,
                "Line Editor",
                chapter.title.as_str(),
                "Author",
                Some("bot-1"),
                Some(id),
                Some("suggestion_insert"),
                Some(chapter.id.as_str()),
            )
            .unwrap()
            .expect("one commit per id");
        decided.push(oid);
    }
    assert_ne!(decided[0], decided[1]);
    let first = found(svc.resolve_change(&store, &m.id, "chg-a").unwrap());
    let second = found(svc.resolve_change(&store, &m.id, "chg-b").unwrap());
    assert_eq!(first.decided_commit.as_deref(), Some(decided[0].as_str()));
    assert_eq!(first.decision.as_deref(), Some("accepted"));
    assert_eq!(second.decided_commit.as_deref(), Some(decided[1].as_str()));
    assert_eq!(second.decision.as_deref(), Some("rejected"));
    let accepted = svc
        .history(&store, &m.id, 10, 0)
        .unwrap()
        .into_iter()
        .filter(|c| c.message.starts_with("Accepted") || c.message.starts_with("Rejected"))
        .count();
    assert_eq!(accepted, 2);
}

#[test]
fn resolve_change_uses_the_bot_commit_that_added_the_id() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "bot-intro.draft");
    svc.commit_now(
        &store,
        &m.id,
        "Baseline",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap();
    match svc.resolve_change(&store, &m.id, "chg-bot").unwrap() {
        DraftChangeResolve::NotFound { change_id } => assert_eq!(change_id, "chg-bot"),
        DraftChangeResolve::Found { .. } => panic!("id is not in history yet"),
    }
    set_chapter_mark(&store, &chapter.doc_id, "chg-bot", "harbor light");
    let bot_oid = svc
        .commit_bot_suggestion(
            &store,
            &m.id,
            "agent-test-1",
            "Line Editor",
            "Bot suggestions",
        )
        .unwrap()
        .expect("bot commit");
    let introduced = found(svc.resolve_change(&store, &m.id, "chg-bot").unwrap());
    assert_eq!(introduced.introduced_commit, bot_oid);
    assert!(introduced.introduced_ref.starts_with("bot/"));
    let main_oid = svc
        .commit_now(
            &store,
            &m.id,
            "Edited chapter",
            "Author",
            "author@swarmdraft.local",
        )
        .unwrap()
        .expect("later main snapshot");
    assert_ne!(main_oid, bot_oid);
    let still = found(svc.resolve_change(&store, &m.id, "chg-bot").unwrap());
    assert_eq!(still.introduced_commit, bot_oid);
    assert!(still.introduced_ref.starts_with("bot/"));
}

#[test]
fn reopen_applies_a_newer_resolved_at() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "resolve-comment.draft");
    let thread = "cthread1";
    store
        .insert_comment(
            &m.id,
            &sample_comment(thread, &chapter.id, "Please check this."),
        )
        .unwrap();
    svc.commit_now(&store, &m.id, "Saved", "Author", "author@swarmdraft.local")
        .unwrap();
    let draft_path = store.draft_file_path(&m.id).unwrap().unwrap();

    let dir2 = tempfile::tempdir().unwrap();
    let store2 = Store::open(dir2.path()).unwrap();
    let svc2 = DraftService::new(store2.data_dir().to_path_buf(), "0.2.1".into());
    let opened = svc2
        .open_draft_path(&store2, &draft_path, true)
        .unwrap()
        .unwrap();
    let rows = store2
        .comments_for_manuscript(&opened.manuscript_id)
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert!(rows[0].resolved_at.is_none());

    store
        .set_comment_thread_resolved(&m.id, &chapter.id, thread, true)
        .unwrap();
    svc.commit_now(&store, &m.id, "Saved", "Author", "author@swarmdraft.local")
        .unwrap()
        .expect("resolved comment is committed");
    svc2.open_draft_path(&store2, &draft_path, true)
        .unwrap()
        .unwrap();
    let rows = store2
        .comments_for_manuscript(&opened.manuscript_id)
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert!(rows[0].resolved_at.is_some());
}

#[test]
fn restore_drops_a_comment_added_after_that_commit() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "restore-comments.draft");
    store
        .insert_comment(
            &m.id,
            &sample_comment("cthread1", &chapter.id, "Keep this."),
        )
        .unwrap();
    let older = svc
        .commit_now(&store, &m.id, "Saved", "Author", "author@swarmdraft.local")
        .unwrap()
        .expect("comment commit");
    store
        .insert_comment(
            &m.id,
            &sample_comment("cthread2", &chapter.id, "Added later."),
        )
        .unwrap();
    svc.commit_now(&store, &m.id, "Saved", "Author", "author@swarmdraft.local")
        .unwrap()
        .expect("later comment");
    svc.restore(&store, &m.id, &older, "Author").unwrap();
    let rows = store.comments_for_manuscript(&m.id).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "cthread1");
}

#[test]
fn legacy_archive_without_comments_keeps_local_rows() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "legacy-comments.draft");
    svc.commit_now(
        &store,
        &m.id,
        "Baseline",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap();
    let comments = svc.worktree_path(&m.id).join("comments");
    fs::remove_dir_all(&comments).unwrap();
    DraftRepo::open_working(&svc.worktree_path(&m.id))
        .unwrap()
        .commit_all(
            "Older draft",
            "Author",
            "author@swarmdraft.local",
            &CommitOptions::default(),
        )
        .unwrap()
        .expect("strip comments");
    svc.pack_if_linked(&store, &m.id).unwrap();
    let draft_path = store.draft_file_path(&m.id).unwrap().unwrap();

    let dir2 = tempfile::tempdir().unwrap();
    let store2 = Store::open(dir2.path()).unwrap();
    let svc2 = DraftService::new(store2.data_dir().to_path_buf(), "0.2.1".into());
    let opened = svc2
        .open_draft_path(&store2, &draft_path, true)
        .unwrap()
        .expect("older draft opens");
    let section = store2
        .list_sections(&opened.manuscript_id)
        .unwrap()
        .into_iter()
        .find(|s| s.kind == "chapter")
        .unwrap();
    store2
        .insert_comment(
            &opened.manuscript_id,
            &sample_comment("clocalextra", &section.id, "Kept locally."),
        )
        .unwrap();
    svc2.open_draft_path(&store2, &draft_path, true)
        .unwrap()
        .unwrap();
    let rows = store2
        .comments_for_manuscript(&opened.manuscript_id)
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "clocalextra");
}

#[test]
fn comment_edit_commits_inside_the_checkpoint_window() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "comment-now.draft");
    set_chapter_plain(&store, &chapter.doc_id, "before");
    let first = svc
        .checkpoint_if_due(&store, &m.id, "Edited chapter", false)
        .unwrap()
        .expect("first checkpoint");
    store
        .insert_comment(
            &m.id,
            &sample_comment("cthread1", &chapter.id, "Please check this."),
        )
        .unwrap();
    assert!(svc
        .checkpoint_if_due(&store, &m.id, "Edited chapter", false)
        .unwrap()
        .is_none());
    let second = svc
        .checkpoint_if_due(&store, &m.id, "Edited chapter", true)
        .unwrap()
        .expect("comment commit does not wait");
    assert_ne!(first, second);
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let bytes = repo
        .file_bytes(&second, "comments/cthread1.json")
        .unwrap()
        .expect("thread file");
    assert!(String::from_utf8(bytes)
        .unwrap()
        .contains("Please check this."));
}

#[test]
fn bot_comment_lands_on_the_bot_branch() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "bot-comment.draft");
    svc.commit_now(
        &store,
        &m.id,
        "Baseline",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap();
    store
        .insert_comment(
            &m.id,
            &sample_comment("cthread1", &chapter.id, "Which lantern?"),
        )
        .unwrap();
    let oid = svc
        .commit_bot_suggestion(&store, &m.id, "agent-test-1", "Line Editor", "Bot comment")
        .unwrap()
        .expect("bot comment commit");
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let bytes = repo
        .file_bytes(&oid, "comments/cthread1.json")
        .unwrap()
        .expect("comment on the bot commit");
    assert!(String::from_utf8(bytes).unwrap().contains("Which lantern?"));
    let main = repo.head_oid().unwrap().unwrap();
    assert_ne!(main, oid);
    assert!(repo
        .file_bytes(&main, "comments/cthread1.json")
        .unwrap()
        .is_none());
    let head = repo.head_name().unwrap().unwrap();
    assert!(head == "main" || head == "master");
}

#[test]
fn failed_session_end_keeps_the_session_ref_moving() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "end-fail.draft");
    set_chapter_plain(&store, &chapter.doc_id, "base");
    svc.commit_now(
        &store,
        &m.id,
        "Baseline",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap();
    let session_id = svc.begin_editing_session(&store, &m.id).unwrap();
    let draft_path = store.draft_file_path(&m.id).unwrap().unwrap();
    fs::remove_file(&draft_path).unwrap();
    fs::create_dir(&draft_path).unwrap();
    let err = svc.end_editing_session(&store, &m.id).unwrap_err();
    assert!(!err.is_empty());
    assert_eq!(
        svc.begin_editing_session(&store, &m.id).unwrap(),
        session_id
    );
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let before = repo
        .branch_target(&format!("session/{session_id}"))
        .unwrap()
        .expect("session ref");
    set_chapter_plain(&store, &chapter.doc_id, "still in the session");
    assert!(svc
        .commit_now(
            &store,
            &m.id,
            "Edited chapter",
            "Author",
            "author@swarmdraft.local",
        )
        .is_err());
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let after = repo
        .branch_target(&format!("session/{session_id}"))
        .unwrap()
        .expect("session ref moved");
    assert_ne!(before, after);
    let message = repo.commit_message(&after).unwrap();
    assert_eq!(message.lines().next(), Some("Edited chapter"));
    assert!(message.contains(&format!("Session: {session_id}")));
}

#[test]
fn packed_manifest_version_is_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo.git");
    fs::create_dir_all(repo.join("objects")).unwrap();
    fs::write(repo.join("HEAD"), "ref: refs/heads/main\n").unwrap();
    let manifest = DraftManifest {
        format: DRAFT_FORMAT.into(),
        format_version: DRAFT_FORMAT_VERSION,
        app_version: "0.2.1".into(),
        book_id: "x".into(),
        title: "T".into(),
    };
    assert_eq!(DRAFT_FORMAT_VERSION, 1);
    let draft = dir.path().join("book.draft");
    pack_draft(&draft, &manifest, &repo).unwrap();
    assert!(Path::new(&draft).is_file());
}
