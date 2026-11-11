//! Git backbone for sessions, comments, and change history (#116).

use std::fs;
use std::path::Path;

use serde_json::json;
use swarmdraft_lib::content::{self, decode};
use swarmdraft_lib::draft::{
    pack_draft, unpack_draft, BotRetention, CommitOptions, DraftChangeResolve, DraftManifest,
    DraftRepo, DraftService, DRAFT_FORMAT, DRAFT_FORMAT_VERSION,
};
use swarmdraft_lib::manuscripts::{
    doc_update_since, state_vector, Author, Comment, OutlineEntry, ReviewDecisionRecord,
};
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
            "marks":[{"type":"suggestion_insert","attrs":{"id": change_id, "author":"agent:agent-test-1","ts":"t"}}]
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

fn markdown_from_yjs(bytes: &[u8]) -> String {
    let doc = content::new_doc();
    doc.transact_mut()
        .apply_update(Update::decode_v1(bytes).unwrap())
        .unwrap();
    content::markdown(&decode(&doc))
}

/// Insert `extra` at the end of the text run that contains `needle`.
fn insert_into_text(doc: &yrs::Doc, needle: &str, extra: &str) {
    use yrs::{GetString, Text, Transact, XmlFragment, XmlOut};
    let frag = doc.get_or_insert_xml_fragment(content::FRAGMENT);
    let (text, index) = {
        let txn = doc.transact();
        let mut found = None;
        for child in frag.children(&txn) {
            let XmlOut::Element(el) = child else {
                continue;
            };
            for inner in el.children(&txn) {
                let XmlOut::Text(text) = inner else {
                    continue;
                };
                let value = text.get_string(&txn);
                if let Some(pos) = value.find(needle) {
                    let index = value[..pos + needle.len()].encode_utf16().count() as u32;
                    found = Some((text, index));
                }
            }
        }
        found.unwrap_or_else(|| panic!("missing text {needle}"))
    };
    let mut txn = doc.transact_mut();
    text.insert(&mut txn, index, extra);
}

fn markdown_has_empty_paragraph(md: &str) -> bool {
    md.split("<!-- block:").skip(1).any(|chunk| {
        chunk
            .split_once("-->")
            .is_some_and(|(_, body)| body.trim().is_empty())
    })
}

fn assert_no_empty_paragraph(store: &Store, doc_id: &str) {
    let doc = store.load_doc(doc_id).unwrap();
    for block in decode(&doc) {
        if block.node["type"] != "paragraph" {
            continue;
        }
        let text = block.node["content"]
            .as_array()
            .map(|nodes| {
                nodes
                    .iter()
                    .filter_map(|node| node["text"].as_str())
                    .collect::<String>()
            })
            .unwrap_or_default();
        assert!(
            !text.is_empty(),
            "empty paragraph in {}",
            chapter_text(store, doc_id)
        );
    }
}

fn only_chapter(store: &Store, manuscript_id: &str) -> swarmdraft_lib::manuscripts::Section {
    store
        .list_sections(manuscript_id)
        .unwrap()
        .into_iter()
        .find(|section| section.kind == "chapter")
        .expect("chapter")
}

fn reopen_without_database(data: &Path, draft_path: &str) -> (Store, DraftService, String) {
    for name in ["swarmdraft.db", "swarmdraft.db-wal", "swarmdraft.db-shm"] {
        let path = data.join(name);
        if path.exists() {
            fs::remove_file(&path).unwrap();
        }
    }
    let store = Store::open(data).unwrap();
    let svc = DraftService::new(data.to_path_buf(), "0.2.1".into());
    let opened = svc
        .open_draft_path(&store, draft_path, true)
        .unwrap()
        .unwrap();
    assert!(
        opened.recovery.is_none(),
        "reopen asked to save a newer copy"
    );
    (store, svc, opened.manuscript_id)
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

fn decision_message_on_bot(repo: &DraftRepo, needle: &str) -> String {
    let oid = bot_commit_with(repo, needle);
    repo.commit_message(&oid).unwrap()
}

fn bot_commit_with(repo: &DraftRepo, needle: &str) -> String {
    for tip in repo.search_ref_tips().unwrap() {
        if !tip.name.starts_with("bot/") {
            continue;
        }
        for commit in repo.walk_first_parent(&tip.oid).unwrap() {
            if commit.message.contains(needle) {
                return commit.oid;
            }
        }
    }
    panic!("no bot commit contains {needle}");
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
    let full = decision_message_on_bot(&repo, "chg-1");
    assert!(full.starts_with("Accepted Line Editor's change in "));
    assert!(full.contains("Change-Id: chg-1"));
    assert!(full.contains("Decision: accepted"));
    assert!(full.contains("Kind: suggestion_insert"));
    assert!(full.contains(&format!("Section: {}", chapter.id)));
    assert!(full.contains(&format!("Session: {session_id}")));
    let bot_oid = bot_commit_with(&repo, "Change-Id: chg-1");
    assert_eq!(repo.committer_name(&bot_oid).unwrap(), "Line Editor");
    let visible = svc.history(&store, &m.id, 8, 0).unwrap();
    assert!(visible.iter().any(|c| c.message.starts_with("Merged bot/")));
    assert!(visible
        .iter()
        .all(|c| !c.message.contains("Change-Id") && !c.message.contains("Session:")));
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
    let mut ids: Vec<_> = rows.iter().map(|c| c.id.as_str()).collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), rows.len());
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
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    assert!(decision_message_on_bot(&repo, "Change-Id: chg-a").contains("Decision: accepted"));
    assert!(decision_message_on_bot(&repo, "Change-Id: chg-b").contains("Decision: rejected"));
    assert!(svc
        .history(&store, &m.id, 12, 0)
        .unwrap()
        .iter()
        .any(|c| c.message.starts_with("Merged bot/")));
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
    // The open insert stays off main, and the checkpoint does not keep an empty
    // paragraph in its place. A real edit is what makes the later snapshot.
    set_chapter_plain(&store, &chapter.doc_id, "later wording");
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
fn reopen_takes_comment_state_from_git() {
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
    store
        .insert_comment(
            &m.id,
            &sample_comment("cthread2", &chapter.id, "Added in the archive."),
        )
        .unwrap();
    svc.commit_now(&store, &m.id, "Saved", "Author", "author@swarmdraft.local")
        .unwrap()
        .expect("new comment is committed");
    svc2.open_draft_path(&store2, &draft_path, true)
        .unwrap()
        .unwrap();
    let rows = store2
        .comments_for_manuscript(&opened.manuscript_id)
        .unwrap();
    assert_eq!(rows.len(), 2);
    let kept = rows.iter().find(|c| c.id == thread).unwrap();
    assert!(kept.resolved_at.is_some());
    assert_eq!(kept.body, "Please check this.");
    assert!(rows.iter().any(|c| c.id == "cthread2"));
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
}

#[test]
fn restore_keeps_a_comment_added_after_that_commit() {
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
    assert_eq!(rows.len(), 2);
    let mut ids: Vec<_> = rows.iter().map(|c| c.id.as_str()).collect();
    ids.sort();
    assert_eq!(ids, vec!["cthread1", "cthread2"]);
    ids.dedup();
    assert_eq!(ids.len(), 2);
}

#[test]
fn unsupported_format_version_does_not_open() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo.git");
    fs::create_dir_all(repo.join("objects")).unwrap();
    fs::write(repo.join("HEAD"), "ref: refs/heads/main\n").unwrap();
    let manifest = DraftManifest {
        format: DRAFT_FORMAT.into(),
        format_version: 1,
        app_version: "0.2.1".into(),
        book_id: "old-book".into(),
        title: "Old".into(),
    };
    let draft = dir.path().join("old.draft");
    pack_draft(&draft, &manifest, &repo).unwrap();
    let (_dir, store) = temp_store();
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    let err = svc
        .open_draft_path(&store, draft.to_str().unwrap(), true)
        .unwrap_err();
    assert!(
        err.contains("unsupported format version"),
        "expected an unsupported format version error, got {err}"
    );
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
fn bot_comment_only_on_bot_branch_survives_open_and_restore() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "bot-only-comment.draft");
    let baseline = svc
        .commit_now(
            &store,
            &m.id,
            "Baseline",
            "Author",
            "author@swarmdraft.local",
        )
        .unwrap()
        .expect("baseline");
    let mut comment = sample_comment("cthread-bot", &chapter.id, "Only on the bot branch.");
    comment.author.kind = "agent".into();
    comment.author.id = "agent-test-1".into();
    comment.author.name = "Line Editor".into();
    store.insert_comment(&m.id, &comment).unwrap();
    let bot_oid = svc
        .commit_bot_suggestion(&store, &m.id, "agent-test-1", "Line Editor", "Bot comment")
        .unwrap()
        .expect("bot comment commit");
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    assert!(repo
        .file_bytes(&bot_oid, "comments/cthread-bot.json")
        .unwrap()
        .is_some());
    let main = repo.head_oid().unwrap().unwrap();
    assert!(repo
        .file_bytes(&main, "comments/cthread-bot.json")
        .unwrap()
        .is_none());
    let draft_path = store.draft_file_path(&m.id).unwrap().unwrap();
    svc.open_draft_path(&store, &draft_path, true)
        .unwrap()
        .unwrap();
    let after_open = store.comments_for_manuscript(&m.id).unwrap();
    assert_eq!(after_open.len(), 1);
    assert_eq!(after_open[0].id, "cthread-bot");
    assert_eq!(after_open[0].body, "Only on the bot branch.");
    svc.restore(&store, &m.id, &baseline, "Author").unwrap();
    let after_restore = store.comments_for_manuscript(&m.id).unwrap();
    assert_eq!(after_restore.len(), 1);
    assert_eq!(after_restore[0].id, "cthread-bot");
    assert_eq!(after_restore[0].body, "Only on the bot branch.");
    svc.open_draft_path(&store, &draft_path, true)
        .unwrap()
        .unwrap();
    assert_eq!(store.comments_for_manuscript(&m.id).unwrap().len(), 1);
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
    assert_eq!(DRAFT_FORMAT_VERSION, 2);
    let draft = dir.path().join("book.draft");
    pack_draft(&draft, &manifest, &repo).unwrap();
    assert!(Path::new(&draft).is_file());
}

fn comment_snapshot(rows: &[Comment]) -> Vec<(String, String, Option<String>, String)> {
    let mut out: Vec<_> = rows
        .iter()
        .map(|c| {
            (
                c.id.clone(),
                c.body.clone(),
                c.resolved_at.clone(),
                c.thread_id.clone().unwrap_or_else(|| c.id.clone()),
            )
        })
        .collect();
    out.sort();
    out
}

fn decision_snapshot(
    by_section: &std::collections::HashMap<String, Vec<ReviewDecisionRecord>>,
) -> Vec<(String, String, String, String, String, String)> {
    let mut out = Vec::new();
    for (section_id, rows) in by_section {
        for row in rows {
            out.push((
                section_id.clone(),
                row.id.clone(),
                row.kind.clone(),
                row.status.clone(),
                row.decided_at.clone(),
                row.decided_by.clone(),
            ));
        }
    }
    out.sort();
    out
}

#[test]
fn deleting_the_local_database_rebuilds_comments_and_decisions() {
    let (dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "rebuild.draft");
    set_chapter_plain(&store, &chapter.doc_id, "harbor");
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
            &sample_comment("cthread", &chapter.id, "Please check this."),
        )
        .unwrap();
    store
        .human_comment_reply(&m.id, &chapter.id, "cthread", "Will do.", "Author", "local")
        .unwrap();
    store
        .set_comment_thread_resolved(&m.id, &chapter.id, "cthread", true)
        .unwrap();
    store
        .insert_comment(&m.id, &sample_comment("cdelete", &chapter.id, "Remove me."))
        .unwrap();
    store.tombstone_comment(&m.id, "cdelete").unwrap();
    store
        .insert_comment(&m.id, &sample_comment("ckeep", &chapter.id, "Still here."))
        .unwrap();
    svc.commit_now(
        &store,
        &m.id,
        "Comments",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap()
    .expect("comment commit");
    let tomb = fs::read_to_string(svc.worktree_path(&m.id).join("comments/cdelete.json")).unwrap();
    assert!(tomb.contains("\"deletedAt\""));
    assert!(tomb.contains("Remove me."));
    assert!(svc
        .worktree_path(&m.id)
        .join("comments/cdelete.json")
        .is_file());

    store
        .save_section_review_decisions(
            &m.id,
            &chapter.id,
            &[
                ReviewDecisionRecord {
                    kind: "suggestion_insert".into(),
                    id: "chg-yes".into(),
                    status: "accepted".into(),
                    decided_at: "2026-02-01T00:00:00.000Z".into(),
                    decided_by: "author".into(),
                },
                ReviewDecisionRecord {
                    kind: "suggestion_delete".into(),
                    id: "chg-no".into(),
                    status: "rejected".into(),
                    decided_at: "2026-02-01T00:00:01.000Z".into(),
                    decided_by: "author".into(),
                },
            ],
        )
        .unwrap();
    svc.commit_review_decision(
        &store,
        &m.id,
        true,
        "Line Editor",
        &chapter.title,
        "author",
        None,
        Some("chg-yes"),
        Some("suggestion_insert"),
        Some(&chapter.id),
    )
    .unwrap()
    .expect("accept commit");
    svc.commit_review_decision(
        &store,
        &m.id,
        false,
        "Line Editor",
        &chapter.title,
        "author",
        None,
        Some("chg-no"),
        Some("suggestion_delete"),
        Some(&chapter.id),
    )
    .unwrap()
    .expect("reject commit");
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let message = decision_message_on_bot(&repo, "Change-Id: chg-no");
    assert!(message.contains("Decision: rejected"));
    assert!(message.contains("Kind: suggestion_delete"));
    assert!(message.contains("Decided-By: author"));
    let head = repo.head_oid().unwrap().unwrap();
    let changes = String::from_utf8(
        repo.file_bytes(&head, "review/changes.json")
            .unwrap()
            .expect("decisions are on main"),
    )
    .unwrap();
    assert!(changes.contains("chg-yes") && changes.contains("chg-no"));

    let before = comment_snapshot(&store.comments_for_manuscript(&m.id).unwrap());
    let decisions_before =
        decision_snapshot(&store.review_decisions_for_manuscript(&m.id).unwrap());
    assert!(before
        .iter()
        .any(|row| row.0 == "cthread" && row.2.is_some()));
    assert!(before.iter().any(|row| row.0 == "ckeep" && row.2.is_none()));
    assert!(before.iter().all(|row| row.0 != "cdelete"));
    assert_eq!(decisions_before.len(), 2);
    let draft_path = store.draft_file_path(&m.id).unwrap().unwrap();
    let data = dir.path().to_path_buf();
    drop(store);
    drop(svc);
    for name in ["swarmdraft.db", "swarmdraft.db-wal", "swarmdraft.db-shm"] {
        let path = data.join(name);
        if path.exists() {
            fs::remove_file(&path).unwrap();
        }
    }
    let store2 = Store::open(&data).unwrap();
    let svc2 = DraftService::new(data, "0.2.1".into());
    let opened = svc2
        .open_draft_path(&store2, &draft_path, true)
        .unwrap()
        .unwrap();
    let after = comment_snapshot(
        &store2
            .comments_for_manuscript(&opened.manuscript_id)
            .unwrap(),
    );
    let decisions_after = decision_snapshot(
        &store2
            .review_decisions_for_manuscript(&opened.manuscript_id)
            .unwrap(),
    );
    assert_eq!(before, after);
    assert_eq!(decisions_before, decisions_after);
    let tomb = fs::read_to_string(
        svc2.worktree_path(&opened.manuscript_id)
            .join("comments/cdelete.json"),
    )
    .unwrap();
    assert!(tomb.contains("\"deletedAt\""));
}

#[test]
fn restore_rolls_back_text_only_and_keeps_later_comments() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "restore-text.draft");
    set_chapter_plain(&store, &chapter.doc_id, "version-one");
    store
        .insert_comment(&m.id, &sample_comment("c1", &chapter.id, "Before restore."))
        .unwrap();
    let first = svc
        .commit_now(&store, &m.id, "First", "Author", "author@swarmdraft.local")
        .unwrap()
        .expect("first");
    set_chapter_plain(&store, &chapter.doc_id, "version-two");
    store
        .insert_comment(
            &m.id,
            &sample_comment("c2", &chapter.id, "After that point."),
        )
        .unwrap();
    let second = svc
        .commit_now(&store, &m.id, "Second", "Author", "author@swarmdraft.local")
        .unwrap()
        .expect("second");
    let new_oid = svc.restore(&store, &m.id, &first, "Author").unwrap();
    assert_ne!(new_oid, first);
    assert_ne!(new_oid, second);
    assert!(chapter_text(&store, &chapter.doc_id).contains("version-one"));
    assert!(!chapter_text(&store, &chapter.doc_id).contains("version-two"));
    let rows = store.comments_for_manuscript(&m.id).unwrap();
    let mut ids: Vec<_> = rows.iter().map(|c| c.id.as_str()).collect();
    ids.sort();
    assert_eq!(ids, vec!["c1", "c2"]);
    let history = svc.history(&store, &m.id, 10, 0).unwrap();
    assert!(history.iter().any(|c| c.oid == first));
    assert!(history.iter().any(|c| c.oid == second));
    assert!(history
        .iter()
        .any(|c| c.message.starts_with("Restored version")));
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let head = repo.head_oid().unwrap().unwrap();
    assert_eq!(head, new_oid);
    let kept = repo
        .file_bytes(&head, "comments/c2.json")
        .unwrap()
        .expect("later comment stays on the new commit");
    assert!(String::from_utf8(kept)
        .unwrap()
        .contains("After that point."));
}

#[test]
fn accepting_a_bot_change_brings_its_comment_onto_main() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "bot-accept-comment.draft");
    svc.commit_now(
        &store,
        &m.id,
        "Baseline",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap();
    let mut comment = sample_comment("cthread-bot", &chapter.id, "On the bot branch.");
    comment.author.kind = "agent".into();
    comment.author.id = "agent-test-1".into();
    comment.author.name = "Line Editor".into();
    store.insert_comment(&m.id, &comment).unwrap();
    svc.commit_bot_suggestion(&store, &m.id, "agent-test-1", "Line Editor", "Bot comment")
        .unwrap()
        .expect("bot comment");
    svc.commit_review_decision(
        &store,
        &m.id,
        true,
        "Line Editor",
        &chapter.title,
        "author",
        Some("agent-test-1"),
        Some("chg-bot"),
        Some("suggestion_insert"),
        Some(&chapter.id),
    )
    .unwrap();
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let main = repo.head_oid().unwrap().unwrap();
    let bytes = repo
        .file_bytes(&main, "comments/cthread-bot.json")
        .unwrap()
        .expect("comment is on main");
    let text = String::from_utf8(bytes).unwrap();
    assert!(text.contains("On the bot branch."));
    assert!(!text.contains("deletedAt"));
    let row = store
        .comments_for_manuscript(&m.id)
        .unwrap()
        .into_iter()
        .find(|c| c.id == "cthread-bot")
        .unwrap();
    assert!(row.resolved_at.is_none());
}

/// The author edits the chapter after the bot snapshot, then accepts. The
/// accepted sentence stays on HEAD, in the worktree, and in the packed file.
/// A title edited on main after the branch point stays too. Reopen does not
/// offer to save a newer copy.
#[test]
fn accepting_after_an_author_edit_keeps_the_accepted_chapter() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "bot-accept-edited.draft");
    set_chapter_plain(&store, &chapter.doc_id, "version-one");
    svc.commit_now(
        &store,
        &m.id,
        "Baseline",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap()
    .expect("baseline");
    set_chapter_mark(&store, &chapter.doc_id, "chg-pending", "guttered");
    let mut comment = sample_comment("cthread-pending", &chapter.id, "On the suggestion.");
    comment.author.kind = "agent".into();
    comment.author.id = "agent-test-1".into();
    comment.author.name = "Line Editor".into();
    store.insert_comment(&m.id, &comment).unwrap();
    svc.commit_bot_suggestion(
        &store,
        &m.id,
        "agent-test-1",
        "Line Editor",
        "Bot suggestion",
    )
    .unwrap()
    .expect("bot suggestion");
    let accepted = "version-one OUTSIDE guttered KEPT";
    set_chapter_plain(&store, &chapter.doc_id, accepted);
    let style = store.get_manuscript(&m.id).unwrap().numbering_style;
    store
        .update_manuscript_metadata(&m.id, "Title Kept After Branch", &style, None)
        .unwrap();
    svc.commit_review_decision(
        &store,
        &m.id,
        true,
        "Line Editor",
        &chapter.title,
        "author",
        Some("agent-test-1"),
        Some("chg-pending"),
        Some("suggestion_insert"),
        Some(&chapter.id),
    )
    .unwrap();
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let main = repo.head_oid().unwrap().unwrap();
    let chapter_path = format!("chapters/{}.md", chapter.id);
    let yjs_path = format!("yjs/{}.bin", chapter.id);
    let head_md = String::from_utf8(
        repo.file_bytes(&main, &chapter_path)
            .unwrap()
            .expect("chapter on HEAD"),
    )
    .unwrap();
    assert_accepted_chapter(&head_md, accepted);
    let work_md = fs::read_to_string(svc.worktree_path(&m.id).join(&chapter_path)).unwrap();
    assert_eq!(work_md, head_md, "worktree chapter disagrees with HEAD");
    let head_yjs = repo
        .file_bytes(&main, &yjs_path)
        .unwrap()
        .expect("yjs on HEAD");
    let work_yjs = fs::read(svc.worktree_path(&m.id).join(&yjs_path)).unwrap();
    assert_eq!(work_yjs, head_yjs, "worktree yjs disagrees with HEAD");
    assert_accepted_chapter(&markdown_from_yjs(&head_yjs), accepted);
    let book = String::from_utf8(repo.file_bytes(&main, "book.json").unwrap().unwrap()).unwrap();
    assert!(
        book.contains("Title Kept After Branch"),
        "an edit the bot did not touch was replaced by the snapshot: {book}"
    );
    let comment_on_main = String::from_utf8(
        repo.file_bytes(&main, "comments/cthread-pending.json")
            .unwrap()
            .expect("bot comment is on main"),
    )
    .unwrap();
    assert!(comment_on_main.contains("On the suggestion."));
    let draft_path = store.draft_file_path(&m.id).unwrap().unwrap();
    let opened = svc
        .open_draft_path(&store, &draft_path, false)
        .unwrap()
        .unwrap();
    assert!(
        opened.recovery.is_none(),
        "reopen asked to save a newer copy"
    );
    assert_eq!(opened.manuscript_id, m.id);
    assert_accepted_chapter(&chapter_text(&store, &chapter.doc_id), accepted);
    let reopened_title = store.get_manuscript(&m.id).unwrap().title;
    assert_eq!(reopened_title, "Title Kept After Branch");
}

fn assert_accepted_chapter(text: &str, accepted: &str) {
    assert!(text.contains(accepted), "accepted text missing: {text}");
    assert!(
        !text.contains("suggestion:chg-pending"),
        "suggestion mark replaced the accepted chapter: {text}"
    );
}

/// The bot snapshot copies a chapter that is not on `main` yet. The writer
/// deletes it and accepts. The merge records the bot parent and keeps the
/// accept tree, so the chapter is gone on HEAD, in the packed file, and after
/// reopen.
#[test]
fn accepting_after_the_writer_deletes_a_chapter_the_bot_snapshot_copied() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored).clone();
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "bot-accept-deleted-chapter.draft");
    set_chapter_plain(&store, &chapter.doc_id, "version-one");
    svc.commit_now(
        &store,
        &m.id,
        "Baseline",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap()
    .expect("baseline");
    let added = store
        .add_section(&m.id, "chapter", "Gone Chapter", None)
        .unwrap();
    set_chapter_plain(&store, &added.doc_id, "temporary chapter");
    svc.commit_bot_suggestion(
        &store,
        &m.id,
        "agent-test-1",
        "Line Editor",
        "Bot suggestion",
    )
    .unwrap()
    .expect("bot suggestion");
    let kept: Vec<OutlineEntry> = store
        .list_sections(&m.id)
        .unwrap()
        .into_iter()
        .filter(|s| s.id != added.id)
        .map(|s| OutlineEntry {
            id: s.id,
            parent_id: s.parent_id,
            kind: s.kind,
            title: s.title,
            doc_id: s.doc_id,
        })
        .collect();
    store.save_outline(&m.id, &kept).unwrap();
    assert!(store
        .list_sections(&m.id)
        .unwrap()
        .iter()
        .all(|s| s.id != added.id));
    svc.commit_review_decision(
        &store,
        &m.id,
        true,
        "Line Editor",
        &chapter.title,
        "author",
        Some("agent-test-1"),
        Some("chg-pending"),
        Some("suggestion_insert"),
        Some(&chapter.id),
    )
    .unwrap();
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let main = repo.head_oid().unwrap().unwrap();
    assert!(
        repo.commit_message(&main)
            .unwrap()
            .starts_with("Merged bot/"),
        "the branch did not merge once the suggestion was decided"
    );
    let parents = repo.parent_oids(&main).unwrap();
    assert_eq!(parents.len(), 2, "merge records main and the bot branch");
    assert_deleted_chapter_absent(&repo, &main, &added.id);
    assert_deleted_chapter_absent(&repo, &parents[0], &added.id);
    let content_book = repo.file_bytes(&parents[0], "book.json").unwrap().unwrap();
    let head_book = repo.file_bytes(&main, "book.json").unwrap().unwrap();
    assert_eq!(head_book, content_book, "merge replaced main's text");
    assert!(
        decision_message_on_bot(&repo, "Change-Id: chg-pending").contains("Decision: accepted"),
        "the decision is not on the bot branch"
    );
    let bot = repo
        .search_ref_tips()
        .unwrap()
        .into_iter()
        .find(|tip| tip.name.starts_with("bot/"))
        .expect("bot snapshot");
    let bot_book =
        String::from_utf8(repo.file_bytes(&bot.oid, "book.json").unwrap().unwrap()).unwrap();
    assert!(
        bot_book.contains("Gone Chapter") && bot_book.contains(&added.id),
        "bot snapshot never copied the chapter: {bot_book}"
    );
    let chapter_path = format!("chapters/{}.md", added.id);
    let yjs_path = format!("yjs/{}.bin", added.id);
    assert!(repo.file_bytes(&bot.oid, &chapter_path).unwrap().is_some());
    assert!(repo.file_bytes(&bot.oid, &yjs_path).unwrap().is_some());
    let work = svc.worktree_path(&m.id);
    assert!(!work.join(&chapter_path).exists());
    assert!(!work.join(&yjs_path).exists());
    assert_accepted_chapter(&chapter_text(&store, &chapter.doc_id), "version-one");

    let draft_path = store.draft_file_path(&m.id).unwrap().unwrap();
    let unpacked = tempfile::tempdir().unwrap();
    unpack_draft(Path::new(&draft_path), unpacked.path()).unwrap();
    let packed = DraftRepo::open_working(&unpacked.path().join("repo.git")).unwrap();
    let packed_head = packed.head_oid().unwrap().unwrap();
    assert_eq!(packed_head, main, "packed file is not the merge commit");
    assert_deleted_chapter_absent(&packed, &packed_head, &added.id);

    let opened = svc
        .open_draft_path(&store, &draft_path, false)
        .unwrap()
        .unwrap();
    assert!(
        opened.recovery.is_none(),
        "reopen asked to save a newer copy"
    );
    assert_eq!(opened.manuscript_id, m.id);
    assert!(store
        .list_sections(&m.id)
        .unwrap()
        .iter()
        .all(|s| s.id != added.id && s.title != "Gone Chapter"));
    assert_accepted_chapter(&chapter_text(&store, &chapter.doc_id), "version-one");
}

fn assert_deleted_chapter_absent(repo: &DraftRepo, oid: &str, section_id: &str) {
    let book = String::from_utf8(repo.file_bytes(oid, "book.json").unwrap().unwrap()).unwrap();
    assert!(
        !book.contains(section_id) && !book.contains("Gone Chapter"),
        "deleted chapter is back in {oid} book.json: {book}"
    );
    assert!(repo
        .file_bytes(oid, &format!("chapters/{section_id}.md"))
        .unwrap()
        .is_none());
    assert!(repo
        .file_bytes(oid, &format!("yjs/{section_id}.bin"))
        .unwrap()
        .is_none());
}

#[test]
fn rejecting_the_bot_branch_keeps_its_comment_resolved_on_main() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "bot-reject-comment.draft");
    svc.commit_now(
        &store,
        &m.id,
        "Baseline",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap();
    let mut comment = sample_comment("cthread-bot", &chapter.id, "Keep this resolved.");
    comment.author.kind = "agent".into();
    comment.author.id = "agent-test-1".into();
    comment.author.name = "Line Editor".into();
    store.insert_comment(&m.id, &comment).unwrap();
    set_chapter_mark(&store, &chapter.doc_id, "chg-bot", "bot wording");
    svc.commit_bot_suggestion(&store, &m.id, "agent-test-1", "Line Editor", "Bot comment")
        .unwrap()
        .expect("bot comment");
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let main_before = repo.head_oid().unwrap().unwrap();
    assert!(repo
        .file_bytes(&main_before, "comments/cthread-bot.json")
        .unwrap()
        .is_none());
    svc.commit_review_decision(
        &store,
        &m.id,
        false,
        "Line Editor",
        &chapter.title,
        "author",
        Some("agent-test-1"),
        Some("chg-bot"),
        Some("suggestion_insert"),
        Some(&chapter.id),
    )
    .unwrap();
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let main = repo.head_oid().unwrap().unwrap();
    let bytes = repo
        .file_bytes(&main, "comments/cthread-bot.json")
        .unwrap()
        .expect("rejected bot comment is on main");
    let text = String::from_utf8(bytes).unwrap();
    assert!(text.contains("Keep this resolved."));
    assert!(
        text.contains("\"resolvedAt\": \""),
        "branch reject marks the comment resolved: {text}"
    );
    let row = store
        .comments_for_manuscript(&m.id)
        .unwrap()
        .into_iter()
        .find(|c| c.id == "cthread-bot")
        .unwrap();
    assert!(row.resolved_at.is_some());
    assert!(svc
        .bot_branch_exists(&store, &m.id, "agent-test-1", "Line Editor")
        .is_err());
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    assert!(decision_message_on_bot(&repo, "Change-Id: chg-bot").contains("Decision: rejected"));
    assert!(svc
        .history(&store, &m.id, 10, 0)
        .unwrap()
        .iter()
        .any(|c| c.message.starts_with("Merged bot/")));
}

#[test]
fn checkpoint_then_reject_still_resolves_the_bot_comment() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "bot-checkpoint-reject.draft");
    svc.commit_now(
        &store,
        &m.id,
        "Baseline",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap();
    set_chapter_mark(&store, &chapter.doc_id, "chg-bot", "bot wording");
    let mut comment = sample_comment("cthread-bot", &chapter.id, "Copied before reject.");
    comment.author.kind = "agent".into();
    comment.author.id = "agent-test-1".into();
    comment.author.name = "Line Editor".into();
    store.insert_comment(&m.id, &comment).unwrap();
    svc.commit_bot_suggestion(&store, &m.id, "agent-test-1", "Line Editor", "Bot comment")
        .unwrap()
        .expect("bot comment");
    svc.commit_now(
        &store,
        &m.id,
        "Checkpoint",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap();
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let mid = repo.head_oid().unwrap().unwrap();
    assert!(
        repo.file_bytes(&mid, "comments/cthread-bot.json")
            .unwrap()
            .is_none(),
        "checkpoint wrote the bot comment onto main before the branch merged"
    );
    svc.commit_review_decision(
        &store,
        &m.id,
        false,
        "Line Editor",
        &chapter.title,
        "author",
        Some("agent-test-1"),
        Some("chg-bot"),
        Some("suggestion_insert"),
        Some(&chapter.id),
    )
    .unwrap();
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let main = repo.head_oid().unwrap().unwrap();
    let text = String::from_utf8(
        repo.file_bytes(&main, "comments/cthread-bot.json")
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert!(text.contains("\"resolvedAt\": \""));
    let row = store
        .comments_for_manuscript(&m.id)
        .unwrap()
        .into_iter()
        .find(|c| c.id == "cthread-bot")
        .unwrap();
    assert!(row.resolved_at.is_some());
}

/// Save the bot comment and suggestion, checkpoint, then let the bot commit run.
/// The checkpoint must not publish those rows onto `main`, or the later reject sees
/// an empty diff and leaves the comment open.
#[test]
fn checkpoint_before_bot_commit_still_resolves_the_bot_comment() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "bot-checkpoint-before-commit.draft");
    set_chapter_plain(&store, &chapter.doc_id, "version-one");
    svc.commit_now(
        &store,
        &m.id,
        "Baseline",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap()
    .expect("baseline");
    let doc = store.load_doc(&chapter.doc_id).unwrap();
    let since = state_vector(&doc);
    content::encode(
        &doc,
        &json!({"type":"doc","content":[{"type":"paragraph","content":[{
            "type":"text",
            "text":"guttered",
            "marks":[{"type":"suggestion_insert","attrs":{"id":"chg-pending","author":"agent:agent-test-1","ts":"t"}}]
        }]}]}),
    )
    .unwrap();
    let update = doc_update_since(&doc, &since);
    let mut comment = sample_comment("cthread-pending", &chapter.id, "Pending before the branch.");
    comment.author.kind = "agent".into();
    comment.author.id = "agent-test-1".into();
    comment.author.name = "Line Editor".into();
    svc.record_bot_write(
        &store,
        &m.id,
        BotRetention {
            comment: Some(comment.clone()),
            doc_id: Some(chapter.doc_id.clone()),
            doc_update: Some(update.clone()),
        },
        || {
            store
                .insert_comment(&m.id, &comment)
                .map_err(|e| e.to_string())?;
            store
                .append_doc_update(&chapter.doc_id, &update)
                .map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        },
    )
    .unwrap();
    svc.commit_now(
        &store,
        &m.id,
        "Checkpoint",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap();
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let mid = repo.head_oid().unwrap().unwrap();
    assert!(
        repo.file_bytes(&mid, "comments/cthread-pending.json")
            .unwrap()
            .is_none(),
        "checkpoint wrote the bot comment before its branch existed"
    );
    let changes = repo
        .file_bytes(&mid, "review/changes.json")
        .unwrap()
        .map(|bytes| String::from_utf8(bytes).unwrap())
        .unwrap_or_default();
    assert!(
        !changes.contains("chg-pending"),
        "checkpoint wrote the bot suggestion before its branch existed: {changes}"
    );
    let chapter_md = String::from_utf8(
        repo.file_bytes(&mid, &format!("chapters/{}.md", chapter.id))
            .unwrap()
            .expect("chapter"),
    )
    .unwrap();
    assert!(chapter_md.contains("version-one"), "{chapter_md}");
    assert!(
        !chapter_md.contains("guttered"),
        "checkpoint wrote the suggestion text: {chapter_md}"
    );
    let pending = store
        .comments_for_manuscript(&m.id)
        .unwrap()
        .into_iter()
        .find(|c| c.id == "cthread-pending")
        .unwrap();
    assert!(pending.resolved_at.is_none());
    assert!(
        svc.bot_branch_exists(&store, &m.id, "agent-test-1", "Line Editor")
            .unwrap(),
        "the checkpoint did not flush the bot commit onto its branch"
    );
    // The checkpoint already committed this suggestion. A later call must not
    // be required to create another commit, and must not move the branch.
    svc.commit_bot_suggestion(&store, &m.id, "agent-test-1", "Line Editor", "Bot comment")
        .unwrap();
    assert!(svc
        .bot_branch_exists(&store, &m.id, "agent-test-1", "Line Editor")
        .unwrap());
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let tip = repo
        .search_ref_tips()
        .unwrap()
        .into_iter()
        .find(|tip| tip.name.starts_with("bot/"))
        .expect("bot tip");
    let bot_changes = String::from_utf8(
        repo.file_bytes(&tip.oid, "review/changes.json")
            .unwrap()
            .expect("bot changes"),
    )
    .unwrap();
    assert!(
        bot_changes.contains("chg-pending"),
        "bot commit dropped the suggestion: {bot_changes}"
    );
    svc.commit_review_decision(
        &store,
        &m.id,
        false,
        "Line Editor",
        &chapter.title,
        "author",
        Some("agent-test-1"),
        Some("chg-pending"),
        Some("suggestion_insert"),
        Some(&chapter.id),
    )
    .unwrap();
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let main = repo.head_oid().unwrap().unwrap();
    let text = String::from_utf8(
        repo.file_bytes(&main, "comments/cthread-pending.json")
            .unwrap()
            .expect("rejected bot comment is on main"),
    )
    .unwrap();
    assert!(text.contains("Pending before the branch."));
    assert!(
        text.contains("\"resolvedAt\": \""),
        "reject did not resolve the comment: {text}"
    );
    let row = store
        .comments_for_manuscript(&m.id)
        .unwrap()
        .into_iter()
        .find(|c| c.id == "cthread-pending")
        .unwrap();
    assert!(row.resolved_at.is_some());
    assert!(svc
        .bot_branch_exists(&store, &m.id, "agent-test-1", "Line Editor")
        .is_err());
}

/// Checkpoint, then accept or reject, then the bot commit — and the other way around.
/// The decision is in the commit that records it. A reject resolves the linked comment.
/// Rebuilding the cache from git and reopening the file keeps both. A bot commit that
/// lands after the decision does not put the suggestion back on `main`.
fn decision_around_a_pending_bot_commit(accepted: bool, decide_before_bot: bool) {
    let (dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    let file = if accepted {
        "decision-accept.draft"
    } else {
        "decision-reject.draft"
    };
    link_draft(&store, &m.id, file);
    set_chapter_plain(&store, &chapter.doc_id, "version-one");
    svc.commit_now(
        &store,
        &m.id,
        "Baseline",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap()
    .expect("baseline");
    let doc = store.load_doc(&chapter.doc_id).unwrap();
    let since = state_vector(&doc);
    content::encode(
        &doc,
        &json!({"type":"doc","content":[{"type":"paragraph","content":[{
            "type":"text",
            "text":"guttered",
            "marks":[{"type":"suggestion_insert","attrs":{"id":"chg-pending","author":"agent:agent-test-1","ts":"t"}}]
        }]}]}),
    )
    .unwrap();
    let update = doc_update_since(&doc, &since);
    let mut comment = sample_comment("cthread-pending", &chapter.id, "Pending before the branch.");
    comment.author.kind = "agent".into();
    comment.author.id = "agent-test-1".into();
    comment.author.name = "Line Editor".into();
    svc.record_bot_write(
        &store,
        &m.id,
        BotRetention {
            comment: Some(comment.clone()),
            doc_id: Some(chapter.doc_id.clone()),
            doc_update: Some(update.clone()),
        },
        || {
            store
                .insert_comment(&m.id, &comment)
                .map_err(|e| e.to_string())?;
            store
                .append_doc_update(&chapter.doc_id, &update)
                .map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        },
    )
    .unwrap();
    svc.commit_now(
        &store,
        &m.id,
        "Checkpoint",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap();
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let checkpoint = repo.head_oid().unwrap().unwrap();
    let checkpoint_changes = repo
        .file_bytes(&checkpoint, "review/changes.json")
        .unwrap()
        .map(|bytes| String::from_utf8(bytes).unwrap())
        .unwrap_or_default();
    assert!(
        !checkpoint_changes.contains("chg-pending"),
        "checkpoint wrote the suggestion before it was decided: {checkpoint_changes}"
    );
    drop(repo);
    {
        let decide = || {
            svc.commit_review_decision(
                &store,
                &m.id,
                accepted,
                "Line Editor",
                &chapter.title,
                "author",
                Some("agent-test-1"),
                Some("chg-pending"),
                Some("suggestion_insert"),
                Some(&chapter.id),
            )
            .unwrap();
        };
        let bot = || {
            // The checkpoint already committed the suggestion onto the bot branch.
            // A later bot commit must not move main or undo the decision. None means
            // that tree was already on the branch.
            svc.commit_bot_suggestion(&store, &m.id, "agent-test-1", "Line Editor", "Bot comment")
                .unwrap();
        };
        if decide_before_bot {
            decide();
            let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
            let decided = repo.head_oid().unwrap().unwrap();
            assert_recorded_decision(&repo, &decided, accepted);
            bot();
            let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
            let main = repo.head_oid().unwrap().unwrap();
            assert_eq!(
                main, decided,
                "the bot commit replaced the decision commit on main"
            );
            assert_recorded_decision(&repo, &main, accepted);
            let chapter_md = String::from_utf8(
                repo.file_bytes(&main, &format!("chapters/{}.md", chapter.id))
                    .unwrap()
                    .expect("chapter"),
            )
            .unwrap();
            if accepted {
                assert!(
                    chapter_md.contains("guttered")
                        && !chapter_md.contains("suggestion:chg-pending"),
                    "accept did not keep the accepted text: {chapter_md}"
                );
            } else {
                assert!(
                    chapter_md.contains("version-one") && !chapter_md.contains("guttered"),
                    "the bot commit put the rejected text back on main: {chapter_md}"
                );
            }
            let tip = repo
                .search_ref_tips()
                .unwrap()
                .into_iter()
                .find(|tip| tip.name.starts_with("bot/"))
                .expect("bot tip");
            let bot_status = change_status(
                &String::from_utf8(
                    repo.file_bytes(&tip.oid, "review/changes.json")
                        .unwrap()
                        .expect("bot changes"),
                )
                .unwrap(),
                "chg-pending",
            );
            assert_eq!(
                bot_status.as_deref(),
                Some(if accepted { "accepted" } else { "rejected" }),
                "the bot commit reopened the decided suggestion: {bot_status:?}"
            );
        } else {
            bot();
            decide();
            let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
            let main = repo.head_oid().unwrap().unwrap();
            assert_recorded_decision(&repo, &main, accepted);
        }
    }
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let main = repo.head_oid().unwrap().unwrap();
    if !accepted {
        let text = String::from_utf8(
            repo.file_bytes(&main, "comments/cthread-pending.json")
                .unwrap()
                .expect("rejected comment is on main"),
        )
        .unwrap();
        assert!(
            text.contains("\"resolvedAt\": \""),
            "reject left the comment unresolved: {text}"
        );
    }
    let draft_path = store.draft_file_path(&m.id).unwrap().unwrap();
    let data = dir.path().to_path_buf();
    drop(store);
    drop(svc);
    drop(repo);
    for name in ["swarmdraft.db", "swarmdraft.db-wal", "swarmdraft.db-shm"] {
        let path = data.join(name);
        if path.exists() {
            fs::remove_file(&path).unwrap();
        }
    }
    let store = Store::open(&data).unwrap();
    let svc = DraftService::new(data, "0.2.1".into());
    let opened = svc
        .open_draft_path(&store, &draft_path, true)
        .unwrap()
        .unwrap();
    let id = opened.manuscript_id;
    let decisions = store.review_decisions_for_manuscript(&id).unwrap();
    let decision = decisions
        .values()
        .flatten()
        .find(|row| row.id == "chg-pending")
        .unwrap_or_else(|| panic!("reopen lost the decision: {decisions:?}"));
    assert_eq!(
        decision.status,
        if accepted { "accepted" } else { "rejected" }
    );
    let comment = store
        .comments_for_manuscript(&id)
        .unwrap()
        .into_iter()
        .find(|row| row.id == "cthread-pending")
        .expect("reopen lost the comment");
    assert_eq!(comment.body, "Pending before the branch.");
    assert_eq!(comment.resolved_at.is_some(), !accepted);
    if decide_before_bot {
        let chapter = store
            .list_sections(&id)
            .unwrap()
            .into_iter()
            .find(|section| section.kind == "chapter")
            .expect("chapter");
        let text = chapter_text(&store, &chapter.doc_id);
        if accepted {
            assert!(
                text.contains("guttered") && !text.contains("suggestion:chg-pending"),
                "reopen lost the accepted text: {text}"
            );
        } else {
            assert!(
                text.contains("version-one") && !text.contains("guttered"),
                "reopen brought the rejected text back: {text}"
            );
        }
    }
}

fn assert_recorded_decision(repo: &DraftRepo, oid: &str, accepted: bool) {
    let changes = repo
        .file_bytes(oid, "review/changes.json")
        .unwrap()
        .map(|bytes| String::from_utf8(bytes).unwrap())
        .unwrap_or_default();
    let status = change_status(&changes, "chg-pending");
    assert_eq!(
        status.as_deref(),
        Some(if accepted { "accepted" } else { "rejected" }),
        "decision missing from {oid}: {changes}"
    );
}

fn change_status(json: &str, id: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    value.as_array()?.iter().find_map(|entry| {
        if entry["id"] == id {
            entry["status"].as_str().map(str::to_string)
        } else {
            None
        }
    })
}

#[test]
fn checkpoint_then_accept_then_bot_commit_keeps_the_decision() {
    decision_around_a_pending_bot_commit(true, true);
}

#[test]
fn checkpoint_then_reject_then_bot_commit_keeps_the_decision() {
    decision_around_a_pending_bot_commit(false, true);
}

#[test]
fn checkpoint_then_bot_commit_then_accept_keeps_the_decision() {
    decision_around_a_pending_bot_commit(true, false);
}

#[test]
fn checkpoint_then_bot_commit_then_reject_keeps_the_decision() {
    decision_around_a_pending_bot_commit(false, false);
}

/// Save the suggestion and its comment, flush the chapter back to the pre-suggestion
/// text, and reject before any checkpoint and before the bot commit. The reject commit
/// carries the comment with `resolvedAt` set. Deleting the database and reopening
/// restores that resolved comment.
#[test]
fn reject_before_checkpoint_keeps_the_bot_comment_resolved() {
    let (dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "reject-before-checkpoint.draft");
    set_chapter_plain(&store, &chapter.doc_id, "version-one");
    svc.commit_now(
        &store,
        &m.id,
        "Baseline",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap()
    .expect("baseline");
    let doc = store.load_doc(&chapter.doc_id).unwrap();
    let since = state_vector(&doc);
    content::encode(
        &doc,
        &json!({"type":"doc","content":[{"type":"paragraph","content":[{
            "type":"text",
            "text":"guttered",
            "marks":[{"type":"suggestion_insert","attrs":{"id":"chg-pending","author":"agent:agent-test-1","ts":"t"}}]
        }]}]}),
    )
    .unwrap();
    let update = doc_update_since(&doc, &since);
    let mut comment = sample_comment("cthread-pending", &chapter.id, "Pending before the branch.");
    comment.author.kind = "agent".into();
    comment.author.id = "agent-test-1".into();
    comment.author.name = "Line Editor".into();
    svc.record_bot_write(
        &store,
        &m.id,
        BotRetention {
            comment: None,
            doc_id: Some(chapter.doc_id.clone()),
            doc_update: Some(update.clone()),
        },
        || {
            store
                .append_doc_update(&chapter.doc_id, &update)
                .map_err(|e| e.to_string())
        },
    )
    .unwrap();
    svc.record_bot_write(
        &store,
        &m.id,
        BotRetention {
            comment: Some(comment.clone()),
            doc_id: None,
            doc_update: None,
        },
        || {
            store
                .insert_comment(&m.id, &comment)
                .map_err(|e| e.to_string())
        },
    )
    .unwrap();
    // The editor applies the reject and flushes that text before the decision commit.
    set_chapter_plain(&store, &chapter.doc_id, "version-one");
    assert!(
        !chapter_text(&store, &chapter.doc_id).contains("guttered"),
        "the flush left the suggestion in the chapter"
    );
    svc.commit_review_decision(
        &store,
        &m.id,
        false,
        "Line Editor",
        &chapter.title,
        "author",
        Some("agent-test-1"),
        Some("chg-pending"),
        Some("suggestion_insert"),
        Some(&chapter.id),
    )
    .unwrap();
    assert!(svc
        .bot_branch_exists(&store, &m.id, "agent-test-1", "Line Editor")
        .is_err());
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let main = repo.head_oid().unwrap().unwrap();
    assert_recorded_decision(&repo, &main, false);
    let text = String::from_utf8(
        repo.file_bytes(&main, "comments/cthread-pending.json")
            .unwrap()
            .expect("reject commit dropped the bot comment"),
    )
    .unwrap();
    assert!(text.contains("Pending before the branch."));
    assert!(
        text.contains("\"resolvedAt\": \""),
        "reject left the comment unresolved: {text}"
    );
    let chapter_md = String::from_utf8(
        repo.file_bytes(&main, &format!("chapters/{}.md", chapter.id))
            .unwrap()
            .expect("chapter"),
    )
    .unwrap();
    assert!(
        chapter_md.contains("version-one") && !chapter_md.contains("guttered"),
        "reject put the suggestion back: {chapter_md}"
    );
    let draft_path = store.draft_file_path(&m.id).unwrap().unwrap();
    let data = dir.path().to_path_buf();
    drop(store);
    drop(svc);
    drop(repo);
    for name in ["swarmdraft.db", "swarmdraft.db-wal", "swarmdraft.db-shm"] {
        let path = data.join(name);
        if path.exists() {
            fs::remove_file(&path).unwrap();
        }
    }
    let store = Store::open(&data).unwrap();
    let svc = DraftService::new(data, "0.2.1".into());
    let opened = svc
        .open_draft_path(&store, &draft_path, true)
        .unwrap()
        .unwrap();
    let id = opened.manuscript_id;
    let decisions = store.review_decisions_for_manuscript(&id).unwrap();
    let decision = decisions
        .values()
        .flatten()
        .find(|row| row.id == "chg-pending")
        .unwrap_or_else(|| panic!("reopen lost the decision: {decisions:?}"));
    assert_eq!(decision.status, "rejected");
    let comment = store
        .comments_for_manuscript(&id)
        .unwrap()
        .into_iter()
        .find(|row| row.id == "cthread-pending")
        .expect("reopen lost the comment");
    assert_eq!(comment.body, "Pending before the branch.");
    assert!(comment.resolved_at.is_some());
    let chapter = store
        .list_sections(&id)
        .unwrap()
        .into_iter()
        .find(|section| section.kind == "chapter")
        .expect("chapter");
    let text = chapter_text(&store, &chapter.doc_id);
    assert!(
        text.contains("version-one") && !text.contains("guttered"),
        "reopen brought the suggestion back: {text}"
    );
}

/// The same reject, then the bot commit and a checkpoint. The comment stays resolved
/// on `main` and the suggestion text stays off the chapter.
#[test]
fn reject_before_checkpoint_stays_resolved_after_the_bot_commit() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "reject-then-bot-commit.draft");
    set_chapter_plain(&store, &chapter.doc_id, "version-one");
    svc.commit_now(
        &store,
        &m.id,
        "Baseline",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap()
    .expect("baseline");
    let doc = store.load_doc(&chapter.doc_id).unwrap();
    let since = state_vector(&doc);
    content::encode(
        &doc,
        &json!({"type":"doc","content":[{"type":"paragraph","content":[{
            "type":"text",
            "text":"guttered",
            "marks":[{"type":"suggestion_insert","attrs":{"id":"chg-pending","author":"agent:agent-test-1","ts":"t"}}]
        }]}]}),
    )
    .unwrap();
    let update = doc_update_since(&doc, &since);
    let mut comment = sample_comment("cthread-pending", &chapter.id, "Pending before the branch.");
    comment.author.kind = "agent".into();
    comment.author.id = "agent-test-1".into();
    comment.author.name = "Line Editor".into();
    svc.record_bot_write(
        &store,
        &m.id,
        BotRetention {
            comment: Some(comment.clone()),
            doc_id: Some(chapter.doc_id.clone()),
            doc_update: Some(update.clone()),
        },
        || {
            store
                .insert_comment(&m.id, &comment)
                .map_err(|e| e.to_string())?;
            store
                .append_doc_update(&chapter.doc_id, &update)
                .map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        },
    )
    .unwrap();
    // The editor applies the reject and flushes that text before the decision commit.
    set_chapter_plain(&store, &chapter.doc_id, "version-one");
    svc.commit_review_decision(
        &store,
        &m.id,
        false,
        "Line Editor",
        &chapter.title,
        "author",
        Some("agent-test-1"),
        Some("chg-pending"),
        Some("suggestion_insert"),
        Some(&chapter.id),
    )
    .unwrap();
    svc.commit_bot_suggestion(&store, &m.id, "agent-test-1", "Line Editor", "Bot comment")
        .unwrap()
        .expect("bot comment");
    svc.commit_now(
        &store,
        &m.id,
        "Checkpoint",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap();
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let main = repo.head_oid().unwrap().unwrap();
    let text = String::from_utf8(
        repo.file_bytes(&main, "comments/cthread-pending.json")
            .unwrap()
            .expect("checkpoint dropped the bot comment"),
    )
    .unwrap();
    assert!(
        text.contains("\"resolvedAt\": \""),
        "the bot commit reopened the comment: {text}"
    );
    let chapter_md = String::from_utf8(
        repo.file_bytes(&main, &format!("chapters/{}.md", chapter.id))
            .unwrap()
            .expect("chapter"),
    )
    .unwrap();
    assert!(
        chapter_md.contains("version-one") && !chapter_md.contains("guttered"),
        "the bot commit put the suggestion back on main: {chapter_md}"
    );
    let row = store
        .comments_for_manuscript(&m.id)
        .unwrap()
        .into_iter()
        .find(|c| c.id == "cthread-pending")
        .unwrap();
    assert!(row.resolved_at.is_some());
}

/// Type into a suggestion whose `bot/*` commit has not run, then checkpoint.
/// The keystroke is in that commit and still there after reopen. The suggestion
/// id and the bot comment stay off `main`, so rejecting the branch still resolves it.
#[test]
fn checkpoint_keeps_a_keystroke_typed_into_a_pending_suggestion() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "bot-keystroke-before-commit.draft");
    set_chapter_plain(&store, &chapter.doc_id, "version-one");
    svc.commit_now(
        &store,
        &m.id,
        "Baseline",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap()
    .expect("baseline");
    let doc = store.load_doc(&chapter.doc_id).unwrap();
    let since = state_vector(&doc);
    content::encode(
        &doc,
        &json!({"type":"doc","content":[{"type":"paragraph","content":[{
            "type":"text",
            "text":"guttered",
            "marks":[{"type":"suggestion_insert","attrs":{"id":"chg-pending","author":"agent:agent-test-1","ts":"t"}}]
        }]}]}),
    )
    .unwrap();
    let update = doc_update_since(&doc, &since);
    let mut comment = sample_comment("cthread-kept", &chapter.id, "Pending before the branch.");
    comment.author.kind = "agent".into();
    comment.author.id = "agent-test-1".into();
    comment.author.name = "Line Editor".into();
    svc.record_bot_write(
        &store,
        &m.id,
        BotRetention {
            comment: Some(comment.clone()),
            doc_id: Some(chapter.doc_id.clone()),
            doc_update: Some(update.clone()),
        },
        || {
            store
                .insert_comment(&m.id, &comment)
                .map_err(|e| e.to_string())?;
            store
                .append_doc_update(&chapter.doc_id, &update)
                .map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        },
    )
    .unwrap();
    let doc = store.load_doc(&chapter.doc_id).unwrap();
    let since = state_vector(&doc);
    insert_into_text(&doc, "guttered", " KEPT");
    let typed = doc_update_since(&doc, &since);
    store.append_doc_update(&chapter.doc_id, &typed).unwrap();
    assert!(
        chapter_text(&store, &chapter.doc_id).contains("KEPT"),
        "the keystroke was not saved"
    );
    svc.commit_now(
        &store,
        &m.id,
        "Checkpoint",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap();
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let mid = repo.head_oid().unwrap().unwrap();
    assert!(
        repo.file_bytes(&mid, "comments/cthread-kept.json")
            .unwrap()
            .is_none(),
        "checkpoint wrote the bot comment before its branch existed"
    );
    let changes = repo
        .file_bytes(&mid, "review/changes.json")
        .unwrap()
        .map(|bytes| String::from_utf8(bytes).unwrap())
        .unwrap_or_default();
    assert!(
        !changes.contains("chg-pending"),
        "checkpoint wrote the suggestion id before its branch existed: {changes}"
    );
    let chapter_md = String::from_utf8(
        repo.file_bytes(&mid, &format!("chapters/{}.md", chapter.id))
            .unwrap()
            .expect("chapter"),
    )
    .unwrap();
    assert!(
        chapter_md.contains("KEPT"),
        "checkpoint dropped the keystroke: {chapter_md}"
    );
    let draft_path = store.draft_file_path(&m.id).unwrap().unwrap();
    let opened = svc
        .open_draft_path(&store, &draft_path, true)
        .unwrap()
        .unwrap();
    assert_eq!(opened.manuscript_id, m.id);
    let reopened = chapter_text(&store, &chapter.doc_id);
    assert!(
        reopened.contains("KEPT"),
        "reopen dropped the keystroke: {reopened}"
    );
    svc.commit_now(
        &store,
        &m.id,
        "Checkpoint after reopen",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap();
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let after = repo.head_oid().unwrap().unwrap();
    let changes = repo
        .file_bytes(&after, "review/changes.json")
        .unwrap()
        .map(|bytes| String::from_utf8(bytes).unwrap())
        .unwrap_or_default();
    assert!(
        !changes.contains("chg-pending"),
        "checkpoint after reopen wrote the suggestion id: {changes}"
    );
    let chapter_md = String::from_utf8(
        repo.file_bytes(&after, &format!("chapters/{}.md", chapter.id))
            .unwrap()
            .expect("chapter"),
    )
    .unwrap();
    assert!(
        chapter_md.contains("KEPT"),
        "checkpoint after reopen dropped the keystroke: {chapter_md}"
    );
    svc.commit_bot_suggestion(&store, &m.id, "agent-test-1", "Line Editor", "Bot comment")
        .unwrap()
        .expect("bot comment");
    svc.commit_review_decision(
        &store,
        &m.id,
        false,
        "Line Editor",
        &chapter.title,
        "author",
        Some("agent-test-1"),
        Some("chg-pending"),
        Some("suggestion_insert"),
        Some(&chapter.id),
    )
    .unwrap();
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let main = repo.head_oid().unwrap().unwrap();
    let text = String::from_utf8(
        repo.file_bytes(&main, "comments/cthread-kept.json")
            .unwrap()
            .expect("rejected bot comment is on main"),
    )
    .unwrap();
    assert!(text.contains("Pending before the branch."));
    assert!(
        text.contains("\"resolvedAt\": \""),
        "reject did not resolve the comment: {text}"
    );
    let row = store
        .comments_for_manuscript(&m.id)
        .unwrap()
        .into_iter()
        .find(|c| c.id == "cthread-kept")
        .unwrap();
    assert!(row.resolved_at.is_some());
}

#[test]
fn rejecting_the_bot_branch_leaves_the_writer_comment_and_suggestion() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "bot-writer-reject.draft");
    svc.commit_now(
        &store,
        &m.id,
        "Baseline",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap();
    set_chapter_authored_marks(
        &store,
        &chapter.doc_id,
        &[
            ("chg-writer", "writer wording", "Author"),
            ("chg-bot", "bot wording", "agent:agent-test-1"),
        ],
    );
    store
        .insert_comment(
            &m.id,
            &sample_comment("c-writer", &chapter.id, "Writer note."),
        )
        .unwrap();
    let mut bot = sample_comment("c-bot", &chapter.id, "Bot note.");
    bot.author.kind = "agent".into();
    bot.author.id = "agent-test-1".into();
    bot.author.name = "Line Editor".into();
    store.insert_comment(&m.id, &bot).unwrap();
    svc.commit_bot_suggestion(&store, &m.id, "agent-test-1", "Line Editor", "Bot comment")
        .unwrap()
        .expect("bot comment");
    svc.commit_now(
        &store,
        &m.id,
        "Checkpoint",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap()
    .expect("checkpoint copies the writer comment onto main");
    let mut writer = store
        .comments_for_manuscript(&m.id)
        .unwrap()
        .into_iter()
        .find(|c| c.id == "c-writer")
        .unwrap();
    writer.body = "Edited before reject.".into();
    store.upsert_comment(&m.id, &writer).unwrap();
    svc.commit_review_decision(
        &store,
        &m.id,
        false,
        "Line Editor",
        &chapter.title,
        "author",
        Some("agent-test-1"),
        Some("chg-bot"),
        Some("suggestion_insert"),
        Some(&chapter.id),
    )
    .unwrap();
    let rows = store.comments_for_manuscript(&m.id).unwrap();
    let writer = rows.iter().find(|c| c.id == "c-writer").unwrap();
    assert_eq!(writer.body, "Edited before reject.");
    assert!(
        writer.resolved_at.is_none(),
        "a writer comment is not resolved with the bot branch"
    );
    let bot = rows.iter().find(|c| c.id == "c-bot").unwrap();
    assert!(bot.resolved_at.is_some());
    assert!(svc
        .bot_branch_exists(&store, &m.id, "agent-test-1", "Line Editor")
        .is_err());
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let main = repo.head_oid().unwrap().unwrap();
    let writer_file = String::from_utf8(
        repo.file_bytes(&main, "comments/c-writer.json")
            .unwrap()
            .expect("writer comment stays on main"),
    )
    .unwrap();
    assert!(writer_file.contains("Edited before reject."));
    assert!(
        !writer_file.contains("\"resolvedAt\": \""),
        "the decision commit keeps the writer comment unresolved: {writer_file}"
    );
    let bot_file = String::from_utf8(
        repo.file_bytes(&main, "comments/c-bot.json")
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert!(bot_file.contains("\"resolvedAt\": \""));
}

#[test]
fn rejecting_one_suggestion_still_lets_the_other_be_accepted() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "bot-one-of-two.draft");
    svc.commit_now(
        &store,
        &m.id,
        "Baseline",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap();
    set_chapter_marks(
        &store,
        &chapter.doc_id,
        &[("chg-a", "first"), ("chg-b", "second")],
    );
    for (id, body) in [
        ("c-a", "Comment on the first."),
        ("c-b", "Comment on the second."),
    ] {
        let mut comment = sample_comment(id, &chapter.id, body);
        comment.author.kind = "agent".into();
        comment.author.id = "agent-test-1".into();
        comment.author.name = "Line Editor".into();
        store.insert_comment(&m.id, &comment).unwrap();
    }
    svc.commit_bot_suggestion(&store, &m.id, "agent-test-1", "Line Editor", "Bot comments")
        .unwrap()
        .expect("bot comments");
    svc.commit_review_decision(
        &store,
        &m.id,
        false,
        "Line Editor",
        &chapter.title,
        "author",
        Some("agent-test-1"),
        Some("chg-a"),
        Some("suggestion_insert"),
        Some(&chapter.id),
    )
    .unwrap();
    for row in store.comments_for_manuscript(&m.id).unwrap() {
        assert!(
            row.resolved_at.is_none(),
            "{} was resolved by one suggestion reject",
            row.id
        );
    }
    assert!(svc
        .bot_branch_exists(&store, &m.id, "agent-test-1", "Line Editor")
        .unwrap());
    svc.commit_review_decision(
        &store,
        &m.id,
        true,
        "Line Editor",
        &chapter.title,
        "author",
        Some("agent-test-1"),
        Some("chg-b"),
        Some("suggestion_insert"),
        Some(&chapter.id),
    )
    .unwrap();
    assert!(svc
        .history(&store, &m.id, 10, 0)
        .unwrap()
        .iter()
        .any(|c| c.message.starts_with("Merged bot/")));
    assert!(svc
        .bot_branch_exists(&store, &m.id, "agent-test-1", "Line Editor")
        .is_err());
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let main = repo.head_oid().unwrap().unwrap();
    for (path, body) in [
        ("comments/c-a.json", "Comment on the first."),
        ("comments/c-b.json", "Comment on the second."),
    ] {
        let text = String::from_utf8(repo.file_bytes(&main, path).unwrap().expect(path)).unwrap();
        assert!(text.contains(body), "{path} missing on main");
    }
    let still_open = store
        .comments_for_manuscript(&m.id)
        .unwrap()
        .into_iter()
        .find(|c| c.id == "c-b")
        .unwrap();
    assert!(still_open.resolved_at.is_none());
}

/// Two suggestions saved before the book has a commit. The first checkpoint
/// leaves those ids out of `main`. Rejecting one resolves only its comment.
#[test]
fn rejecting_one_suggestion_before_the_first_commit_leaves_the_other_comment_open() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "bot-before-first-commit.draft");
    set_chapter_plain(&store, &chapter.doc_id, "chapter start");

    let doc = store.load_doc(&chapter.doc_id).unwrap();
    let since = state_vector(&doc);
    content::encode(
        &doc,
        &json!({"type":"doc","content":[{"type":"paragraph","content":[{
            "type":"text",
            "text":"first wording",
            "marks":[{"type":"suggestion_insert","attrs":{"id":"chg-a","author":"agent:agent-test-1","ts":"t"}}]
        }]}]}),
    )
    .unwrap();
    let first_update = doc_update_since(&doc, &since);
    let mut first = sample_comment("c-a", &chapter.id, "Comment on the first.");
    first.author.kind = "agent".into();
    first.author.id = "agent-test-1".into();
    first.author.name = "Line Editor".into();
    svc.record_bot_write(
        &store,
        &m.id,
        BotRetention {
            comment: Some(first.clone()),
            doc_id: Some(chapter.doc_id.clone()),
            doc_update: Some(first_update.clone()),
        },
        || {
            store
                .insert_comment(&m.id, &first)
                .map_err(|e| e.to_string())?;
            store
                .append_doc_update(&chapter.doc_id, &first_update)
                .map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        },
    )
    .unwrap();

    let doc = store.load_doc(&chapter.doc_id).unwrap();
    let since = state_vector(&doc);
    content::encode(
        &doc,
        &json!({"type":"doc","content":[{"type":"paragraph","content":[
            {
                "type":"text",
                "text":"first wording",
                "marks":[{"type":"suggestion_insert","attrs":{"id":"chg-a","author":"agent:agent-test-1","ts":"t"}}]
            },
            {
                "type":"text",
                "text":" second wording",
                "marks":[{"type":"suggestion_insert","attrs":{"id":"chg-b","author":"agent:agent-test-1","ts":"t"}}]
            }
        ]}]}),
    )
    .unwrap();
    let second_update = doc_update_since(&doc, &since);
    let mut second = sample_comment("c-b", &chapter.id, "Comment on the second.");
    second.author.kind = "agent".into();
    second.author.id = "agent-test-1".into();
    second.author.name = "Line Editor".into();
    svc.record_bot_write(
        &store,
        &m.id,
        BotRetention {
            comment: Some(second.clone()),
            doc_id: Some(chapter.doc_id.clone()),
            doc_update: Some(second_update.clone()),
        },
        || {
            store
                .insert_comment(&m.id, &second)
                .map_err(|e| e.to_string())?;
            store
                .append_doc_update(&chapter.doc_id, &second_update)
                .map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        },
    )
    .unwrap();

    svc.commit_bot_suggestion(
        &store,
        &m.id,
        "agent-test-1",
        "Line Editor",
        "Bot suggestions",
    )
    .unwrap()
    .expect("bot suggestions");
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let main = repo.head_oid().unwrap().unwrap();
    let checkpoint = repo
        .file_bytes(&main, "review/changes.json")
        .unwrap()
        .map(|bytes| String::from_utf8(bytes).unwrap())
        .unwrap_or_default();
    assert!(
        !checkpoint.contains("chg-a") && !checkpoint.contains("chg-b"),
        "the first checkpoint published a suggestion that was not decided: {checkpoint}"
    );
    drop(repo);

    svc.commit_review_decision(
        &store,
        &m.id,
        false,
        "Line Editor",
        &chapter.title,
        "author",
        Some("agent-test-1"),
        Some("chg-a"),
        Some("suggestion_insert"),
        Some(&chapter.id),
    )
    .unwrap();
    let comments = store.comments_for_manuscript(&m.id).unwrap();
    assert!(
        comments
            .iter()
            .find(|row| row.id == "c-a")
            .unwrap()
            .resolved_at
            .is_some(),
        "rejecting the first suggestion left its comment open"
    );
    assert!(
        comments
            .iter()
            .find(|row| row.id == "c-b")
            .unwrap()
            .resolved_at
            .is_none(),
        "rejecting the first suggestion resolved the other comment"
    );
    assert!(
        svc.bot_branch_exists(&store, &m.id, "agent-test-1", "Line Editor")
            .unwrap(),
        "the branch merged while a suggestion was still open"
    );
}

/// Two open suggestions are stored on the bot branch, not in the chapter on `main`.
/// Reopening puts both back. A keystroke that was checkpointed on `main` stays.
/// Rejecting one leaves that wording out, keeps the other, and does not leave an
/// empty paragraph where the strip removed an insert.
#[test]
fn reopening_restores_an_open_suggestion_and_keeps_a_keystroke() {
    let (dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "bot-reopen-suggestions.draft");
    set_chapter_plain(&store, &chapter.doc_id, "chapter start");

    let doc = store.load_doc(&chapter.doc_id).unwrap();
    let since = state_vector(&doc);
    content::encode(
        &doc,
        &json!({"type":"doc","content":[{"type":"paragraph","content":[{
            "type":"text",
            "text":"first wording",
            "marks":[{"type":"suggestion_insert","attrs":{"id":"chg-a","author":"agent:agent-test-1","ts":"t"}}]
        }]}]}),
    )
    .unwrap();
    let first_update = doc_update_since(&doc, &since);
    let mut first = sample_comment("c-a", &chapter.id, "Comment on the first.");
    first.author.kind = "agent".into();
    first.author.id = "agent-test-1".into();
    first.author.name = "Line Editor".into();
    svc.record_bot_write(
        &store,
        &m.id,
        BotRetention {
            comment: Some(first.clone()),
            doc_id: Some(chapter.doc_id.clone()),
            doc_update: Some(first_update.clone()),
        },
        || {
            store
                .insert_comment(&m.id, &first)
                .map_err(|e| e.to_string())?;
            store
                .append_doc_update(&chapter.doc_id, &first_update)
                .map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        },
    )
    .unwrap();

    let doc = store.load_doc(&chapter.doc_id).unwrap();
    let since = state_vector(&doc);
    content::encode(
        &doc,
        &json!({"type":"doc","content":[{"type":"paragraph","content":[
            {
                "type":"text",
                "text":"first wording",
                "marks":[{"type":"suggestion_insert","attrs":{"id":"chg-a","author":"agent:agent-test-1","ts":"t"}}]
            },
            {
                "type":"text",
                "text":" second wording",
                "marks":[{"type":"suggestion_insert","attrs":{"id":"chg-b","author":"agent:agent-test-1","ts":"t"}}]
            }
        ]}]}),
    )
    .unwrap();
    let second_update = doc_update_since(&doc, &since);
    let mut second = sample_comment("c-b", &chapter.id, "Comment on the second.");
    second.author.kind = "agent".into();
    second.author.id = "agent-test-1".into();
    second.author.name = "Line Editor".into();
    svc.record_bot_write(
        &store,
        &m.id,
        BotRetention {
            comment: Some(second.clone()),
            doc_id: Some(chapter.doc_id.clone()),
            doc_update: Some(second_update.clone()),
        },
        || {
            store
                .insert_comment(&m.id, &second)
                .map_err(|e| e.to_string())?;
            store
                .append_doc_update(&chapter.doc_id, &second_update)
                .map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        },
    )
    .unwrap();
    svc.commit_bot_suggestion(
        &store,
        &m.id,
        "agent-test-1",
        "Line Editor",
        "Bot suggestions",
    )
    .unwrap()
    .expect("bot suggestions");

    let doc = store.load_doc(&chapter.doc_id).unwrap();
    let since = state_vector(&doc);
    insert_into_text(&doc, "chapter start", " KEY");
    let typed = doc_update_since(&doc, &since);
    store.append_doc_update(&chapter.doc_id, &typed).unwrap();
    svc.commit_now(
        &store,
        &m.id,
        "Checkpoint",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap()
    .expect("checkpoint");
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let main = repo.head_oid().unwrap().unwrap();
    let checkpoint_md = markdown_from_yjs(
        &repo
            .file_bytes(&main, &format!("yjs/{}.bin", chapter.id))
            .unwrap()
            .expect("chapter"),
    );
    assert!(
        checkpoint_md.contains("KEY") && checkpoint_md.contains("chapter start"),
        "checkpoint dropped the keystroke: {checkpoint_md}"
    );
    assert!(
        !checkpoint_md.contains("first wording") && !checkpoint_md.contains("second wording"),
        "checkpoint wrote an open suggestion onto main: {checkpoint_md}"
    );
    assert!(
        !markdown_has_empty_paragraph(&checkpoint_md),
        "checkpoint left an empty paragraph: {checkpoint_md}"
    );
    drop(repo);
    let draft_path = store.draft_file_path(&m.id).unwrap().unwrap();
    let data = dir.path().to_path_buf();
    drop(store);
    drop(svc);

    let (store, svc, id) = reopen_without_database(&data, &draft_path);
    let chapter = only_chapter(&store, &id);
    let opened = chapter_text(&store, &chapter.doc_id);
    assert!(
        opened.contains("first wording") && opened.contains("suggestion:chg-a"),
        "reopen dropped the first suggestion: {opened}"
    );
    assert!(
        opened.contains("second wording") && opened.contains("suggestion:chg-b"),
        "reopen dropped the second suggestion: {opened}"
    );
    assert!(
        opened.contains("chapter start") && opened.contains("KEY"),
        "reopen dropped the keystroke: {opened}"
    );
    assert_no_empty_paragraph(&store, &chapter.doc_id);

    svc.commit_review_decision(
        &store,
        &id,
        false,
        "Line Editor",
        &chapter.title,
        "author",
        Some("agent-test-1"),
        Some("chg-b"),
        Some("suggestion_insert"),
        Some(&chapter.id),
    )
    .unwrap();
    let repo = DraftRepo::open_working(&svc.worktree_path(&id)).unwrap();
    let main = repo.head_oid().unwrap().unwrap();
    let rejected_md = markdown_from_yjs(
        &repo
            .file_bytes(&main, &format!("yjs/{}.bin", chapter.id))
            .unwrap()
            .expect("chapter"),
    );
    assert!(
        rejected_md.contains("KEY") && !rejected_md.contains("second wording"),
        "the reject checkpoint put the rejected wording on main: {rejected_md}"
    );
    assert!(
        !markdown_has_empty_paragraph(&rejected_md),
        "the reject checkpoint left an empty paragraph: {rejected_md}"
    );
    drop(repo);
    drop(store);
    drop(svc);

    let (store, _svc, id) = reopen_without_database(&data, &draft_path);
    let chapter = only_chapter(&store, &id);
    let reopened = chapter_text(&store, &chapter.doc_id);
    assert!(
        reopened.contains("first wording") && reopened.contains("suggestion:chg-a"),
        "reopen dropped the suggestion that is still open: {reopened}"
    );
    assert!(
        !reopened.contains("second wording") && !reopened.contains("suggestion:chg-b"),
        "reopen brought the rejected wording back: {reopened}"
    );
    assert!(
        reopened.contains("KEY") && reopened.contains("chapter start"),
        "reopen dropped the keystroke after the reject: {reopened}"
    );
    assert_no_empty_paragraph(&store, &chapter.doc_id);
}

fn paragraph_bodies(md: &str) -> Vec<String> {
    md.split("<!-- block:")
        .skip(1)
        .filter_map(|chunk| {
            chunk
                .split_once("-->")
                .map(|(_, body)| body.trim().to_string())
        })
        .filter(|body| !body.is_empty())
        .collect()
}

fn set_chapter_blocks(store: &Store, doc_id: &str, blocks: serde_json::Value) {
    let doc = content::new_doc();
    content::encode(&doc, &json!({"type":"doc","content": blocks})).unwrap();
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    store.replace_doc_state(doc_id, &state).unwrap();
}

/// Commit `edit` on the bot branch, checkpoint `main`, delete the database, and reopen.
/// `after_bot` runs after the bot commit and before the checkpoint, so a keystroke can land
/// on the live chapter while the suggestion is still only on `bot/*`.
fn reopen_after_bot_edit(
    file: &str,
    blocks: serde_json::Value,
    edit: impl FnOnce(&yrs::Doc),
    after_bot: impl FnOnce(&Store, &str),
) -> (String, String) {
    let (dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let manuscript_id = stored.manuscript.id.clone();
    let chapter = chapter(&stored);
    let doc_id = chapter.doc_id.clone();
    let section_id = chapter.id.clone();
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &manuscript_id, file);
    set_chapter_blocks(&store, &doc_id, blocks);
    let doc = store.load_doc(&doc_id).unwrap();
    let since = state_vector(&doc);
    edit(&doc);
    let update = doc_update_since(&doc, &since);
    svc.record_bot_write(
        &store,
        &manuscript_id,
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
    svc.commit_bot_suggestion(
        &store,
        &manuscript_id,
        "agent-test-1",
        "Line Editor",
        "Bot suggestions",
    )
    .unwrap()
    .expect("bot suggestions");
    after_bot(&store, &doc_id);
    svc.commit_now(
        &store,
        &manuscript_id,
        "Checkpoint",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap()
    .expect("checkpoint");
    let repo = DraftRepo::open_working(&svc.worktree_path(&manuscript_id)).unwrap();
    let main = repo.head_oid().unwrap().unwrap();
    let checkpoint = markdown_from_yjs(
        &repo
            .file_bytes(&main, &format!("yjs/{section_id}.bin"))
            .unwrap()
            .expect("chapter"),
    );
    drop(repo);
    let draft_path = store.draft_file_path(&manuscript_id).unwrap().unwrap();
    let data = dir.path().to_path_buf();
    drop(store);
    drop(svc);
    let (store, _svc, id) = reopen_without_database(&data, &draft_path);
    let chapter = only_chapter(&store, &id);
    let opened = chapter_text(&store, &chapter.doc_id);
    (checkpoint, opened)
}

fn suggest_replacement(doc: &yrs::Doc, quote: &str, replacement: &str, id: &str) {
    let block = decode(doc).into_iter().next().unwrap().id;
    let mut txn = doc.transact_mut();
    let range = swarmdraft_lib::anchor::resolve(doc, &txn, &block, quote).unwrap();
    swarmdraft_lib::anchor::add_suggestion_marks(
        &mut txn,
        &range,
        id,
        "agent:agent-test-1",
        "t",
        replacement,
    );
}

fn suggest_paragraph_after_first(doc: &yrs::Doc, text: &str, id: &str) {
    let after = decode(doc).into_iter().next().unwrap().id;
    let frag = doc.get_or_insert_xml_fragment(content::FRAGMENT);
    let mut txn = doc.transact_mut();
    swarmdraft_lib::anchor::insert_suggested_paragraphs(
        &mut txn,
        &frag,
        Some(&after),
        &[(text, "body")],
        id,
        "agent:agent-test-1",
        "t",
    )
    .unwrap();
}

fn insert_suggestion_after(doc: &yrs::Doc, needle: &str, extra: &str, id: &str) {
    use yrs::{GetString, Text, Transact, XmlFragment, XmlOut};
    let marks = json!([{
        "type": "suggestion_insert",
        "attrs": {"id": id, "author": "agent:agent-test-1", "ts": "t"}
    }]);
    let keys = content::mark_keys(marks.as_array().unwrap()).unwrap();
    let mut attrs = yrs::types::Attrs::new();
    for (mark, key) in marks.as_array().unwrap().iter().zip(keys) {
        let value = mark.get("attrs").cloned().unwrap_or(json!({}));
        let any = serde_json::from_value(value).unwrap_or(yrs::Any::Null);
        attrs.insert(key.into(), any);
    }
    let frag = doc.get_or_insert_xml_fragment(content::FRAGMENT);
    let (text, index) = {
        let txn = doc.transact();
        let mut found = None;
        for child in frag.children(&txn) {
            let XmlOut::Element(el) = child else { continue };
            for inner in el.children(&txn) {
                let XmlOut::Text(text) = inner else { continue };
                let value = text.get_string(&txn);
                if let Some(pos) = value.find(needle) {
                    let index = value[..pos + needle.len()].encode_utf16().count() as u32;
                    found = Some((text, index));
                }
            }
        }
        found.unwrap_or_else(|| panic!("missing text {needle}"))
    };
    let mut txn = doc.transact_mut();
    text.insert_with_attributes(&mut txn, index, extra, attrs);
}

fn mark_paragraph_format(doc: &yrs::Doc, id: &str) {
    use yrs::{GetString, Text, Transact, XmlFragment, XmlOut};
    let marks = json!([{
        "type": "format_change",
        "attrs": {
            "id": id,
            "author": "agent:agent-test-1",
            "ts": "t",
            "target": "bold",
            "before": "0",
            "after": "1"
        }
    }]);
    let keys = content::mark_keys(marks.as_array().unwrap()).unwrap();
    let mut attrs = yrs::types::Attrs::new();
    for (mark, key) in marks.as_array().unwrap().iter().zip(keys) {
        let value = mark.get("attrs").cloned().unwrap_or(json!({}));
        let any = serde_json::from_value(value).unwrap_or(yrs::Any::Null);
        attrs.insert(key.into(), any);
    }
    let frag = doc.get_or_insert_xml_fragment(content::FRAGMENT);
    let (text, len) = {
        let txn = doc.transact();
        let mut found = None;
        for child in frag.children(&txn) {
            let XmlOut::Element(el) = child else { continue };
            for inner in el.children(&txn) {
                let XmlOut::Text(text) = inner else { continue };
                let value = text.get_string(&txn);
                if value.is_empty() {
                    continue;
                }
                found = Some((text, value.encode_utf16().count() as u32));
                break;
            }
            if found.is_some() {
                break;
            }
        }
        found.expect("paragraph text")
    };
    let mut txn = doc.transact_mut();
    text.format(&mut txn, 0, len, attrs);
}

fn delete_in_paragraph(store: &Store, doc_id: &str, paragraph: usize, needle: &str) {
    use yrs::types::text::YChange;
    use yrs::{Any, Out, Text, Transact, XmlFragment, XmlOut};
    let doc = store.load_doc(doc_id).unwrap();
    let since = state_vector(&doc);
    let frag = doc.get_or_insert_xml_fragment(content::FRAGMENT);
    let (text, index, len) = {
        let txn = doc.transact();
        let mut found = None;
        let mut seen = 0usize;
        for child in frag.children(&txn) {
            let XmlOut::Element(el) = child else { continue };
            if seen == paragraph {
                for inner in el.children(&txn) {
                    let XmlOut::Text(text) = inner else { continue };
                    let mut plain = String::new();
                    for diff in text.diff(&txn, YChange::identity) {
                        if let Out::Any(Any::String(value)) = &diff.insert {
                            plain.push_str(value);
                        }
                    }
                    if let Some(pos) = plain.find(needle) {
                        let index = plain[..pos].encode_utf16().count() as u32;
                        let len = needle.encode_utf16().count() as u32;
                        found = Some((text, index, len));
                        break;
                    }
                }
                break;
            }
            seen += 1;
        }
        found.unwrap_or_else(|| panic!("paragraph {paragraph} has no {needle:?}"))
    };
    {
        let mut txn = doc.transact_mut();
        text.remove_range(&mut txn, index, len);
    }
    let update = doc_update_since(&doc, &since);
    store.append_doc_update(doc_id, &update).unwrap();
}

fn type_at_paragraph_start(store: &Store, doc_id: &str, extra: &str) {
    use yrs::{Text, Transact, XmlFragment, XmlOut};
    let doc = store.load_doc(doc_id).unwrap();
    let since = state_vector(&doc);
    let frag = doc.get_or_insert_xml_fragment(content::FRAGMENT);
    let text = {
        let txn = doc.transact();
        let mut found = None;
        for child in frag.children(&txn) {
            let XmlOut::Element(el) = child else { continue };
            for inner in el.children(&txn) {
                let XmlOut::Text(text) = inner else { continue };
                found = Some(text);
                break;
            }
            if found.is_some() {
                break;
            }
        }
        found.expect("paragraph text")
    };
    {
        let mut txn = doc.transact_mut();
        text.insert(&mut txn, 0, extra);
    }
    let update = doc_update_since(&doc, &since);
    store.append_doc_update(doc_id, &update).unwrap();
}

/// A replacement, a deletion, a format mark, and a paragraph inserted between two others
/// come back as the bot branch stored them. A keystroke at the start of the suggestion's
/// paragraph stays, and the insert stays between the words around it.
#[test]
fn reopening_restores_delete_format_and_inserted_paragraphs() {
    let kept = json!([{
        "type": "paragraph",
        "content": [{"type": "text", "text": "Keep the old phrase here."}]
    }]);
    let (checkpoint, opened) = reopen_after_bot_edit(
        "bot-reopen-replacement.draft",
        kept.clone(),
        |doc| suggest_replacement(doc, "old phrase", "new phrase", "chg-rep"),
        |_, _| {},
    );
    assert_eq!(
        paragraph_bodies(&checkpoint),
        vec!["Keep the old phrase here.".to_string()],
        "checkpoint published the replacement: {checkpoint}"
    );
    assert_eq!(
        paragraph_bodies(&opened),
        vec!["Keep the {--old phrase--}{>>suggestion:chg-rep<<}{++new phrase++}{>>suggestion:chg-rep<<} here.".to_string()],
        "reopen dropped the delete mark on the replacement: {opened}"
    );

    let (checkpoint, opened) = reopen_after_bot_edit(
        "bot-reopen-deletion.draft",
        kept,
        |doc| suggest_replacement(doc, "old phrase", "", "chg-del"),
        |_, _| {},
    );
    assert_eq!(
        paragraph_bodies(&checkpoint),
        vec!["Keep the old phrase here.".to_string()],
        "checkpoint published the deletion mark: {checkpoint}"
    );
    assert_eq!(
        paragraph_bodies(&opened),
        vec!["Keep the {--old phrase--}{>>suggestion:chg-del<<} here.".to_string()],
        "reopen dropped the deletion: {opened}"
    );

    let (checkpoint, opened) = reopen_after_bot_edit(
        "bot-reopen-paragraph.draft",
        json!([
            {"type": "paragraph", "content": [{"type": "text", "text": "alpha"}]},
            {"type": "paragraph", "content": [{"type": "text", "text": "omega"}]}
        ]),
        |doc| suggest_paragraph_after_first(doc, "inserted scene", "chg-para"),
        |_, _| {},
    );
    assert_eq!(
        paragraph_bodies(&checkpoint),
        vec!["alpha".to_string(), "omega".to_string()],
        "checkpoint published the inserted paragraph: {checkpoint}"
    );
    assert_eq!(
        paragraph_bodies(&opened),
        vec![
            "alpha".to_string(),
            "{++inserted scene++}{>>suggestion:chg-para<<}".to_string(),
            "omega".to_string(),
        ],
        "reopen did not put the inserted paragraph between the others: {opened}"
    );

    let (checkpoint, opened) = reopen_after_bot_edit(
        "bot-reopen-keystroke.draft",
        json!([{
            "type": "paragraph",
            "content": [{"type": "text", "text": "The quick fox"}]
        }]),
        |doc| insert_suggestion_after(doc, "The ", "very ", "chg-in"),
        |store, doc_id| type_at_paragraph_start(store, doc_id, "Today "),
    );
    assert_eq!(
        paragraph_bodies(&checkpoint),
        vec!["Today The quick fox".to_string()],
        "checkpoint published the insert or dropped the keystroke: {checkpoint}"
    );
    assert_eq!(
        paragraph_bodies(&opened),
        vec!["Today The {++very ++}{>>suggestion:chg-in<<}quick fox".to_string()],
        "reopen moved the insert or dropped the keystroke: {opened}"
    );

    let (checkpoint, opened) = reopen_after_bot_edit(
        "bot-reopen-format.draft",
        json!([{
            "type": "paragraph",
            "content": [{"type": "text", "text": "styled words"}]
        }]),
        |doc| mark_paragraph_format(doc, "chg-fmt"),
        |_, _| {},
    );
    assert_eq!(
        paragraph_bodies(&checkpoint),
        vec!["styled words".to_string()],
        "checkpoint published the format mark: {checkpoint}"
    );
    assert_eq!(
        paragraph_bodies(&opened),
        vec!["{~~styled words~~}{>>format:chg-fmt: add bold<<}".to_string()],
        "reopen dropped the format mark: {opened}"
    );
}

/// Deleting a word that was already in the paragraph keeps that deletion. The suggestion
/// comes back on that same paragraph: the delete mark and the format mark cover the words
/// that remain, an inline insert stays inline, and a paragraph inserted between two others
/// stays between them. A later paragraph that still has the old sentence does not take the mark.
#[test]
fn reopening_keeps_a_suggestion_after_a_deleted_word() {
    let (checkpoint, opened) = reopen_after_bot_edit(
        "bot-reopen-delete-word-replacement.draft",
        json!([{
            "type": "paragraph",
            "content": [{"type": "text", "text": "Keep the old phrase here."}]
        }]),
        |doc| suggest_replacement(doc, "old phrase", "new phrase", "chg-rep"),
        |store, doc_id| delete_in_paragraph(store, doc_id, 0, "here"),
    );
    assert_eq!(
        paragraph_bodies(&checkpoint),
        vec!["Keep the old phrase .".to_string()],
        "checkpoint published the replacement or restored the deleted word: {checkpoint}"
    );
    assert_eq!(
        paragraph_bodies(&opened),
        vec!["Keep the {--old phrase--}{>>suggestion:chg-rep<<}{++new phrase++}{>>suggestion:chg-rep<<} .".to_string()],
        "reopen moved the replacement off the paragraph the writer edited: {opened}"
    );

    let (checkpoint, opened) = reopen_after_bot_edit(
        "bot-reopen-delete-word-insert.draft",
        json!([{
            "type": "paragraph",
            "content": [{"type": "text", "text": "The quick fox"}]
        }]),
        |doc| insert_suggestion_after(doc, "The ", "very ", "chg-in"),
        |store, doc_id| delete_in_paragraph(store, doc_id, 0, " fox"),
    );
    assert_eq!(
        paragraph_bodies(&checkpoint),
        vec!["The quick".to_string()],
        "checkpoint published the insert or restored fox: {checkpoint}"
    );
    assert_eq!(
        paragraph_bodies(&opened),
        vec!["The {++very ++}{>>suggestion:chg-in<<}quick".to_string()],
        "reopen pulled the insert out of the paragraph: {opened}"
    );

    let (checkpoint, opened) = reopen_after_bot_edit(
        "bot-reopen-delete-word-paragraph.draft",
        json!([
            {"type": "paragraph", "content": [{"type": "text", "text": "alpha"}]},
            {"type": "paragraph", "content": [{"type": "text", "text": "omega"}]}
        ]),
        |doc| suggest_paragraph_after_first(doc, "inserted scene", "chg-para"),
        |store, doc_id| delete_in_paragraph(store, doc_id, 2, "ga"),
    );
    assert_eq!(
        paragraph_bodies(&checkpoint),
        vec!["alpha".to_string(), "ome".to_string()],
        "checkpoint published the inserted paragraph or restored ga: {checkpoint}"
    );
    assert_eq!(
        paragraph_bodies(&opened),
        vec![
            "alpha".to_string(),
            "{++inserted scene++}{>>suggestion:chg-para<<}".to_string(),
            "ome".to_string(),
        ],
        "reopen moved the inserted paragraph after the edited one: {opened}"
    );

    let (checkpoint, opened) = reopen_after_bot_edit(
        "bot-reopen-delete-word-format.draft",
        json!([{
            "type": "paragraph",
            "content": [{"type": "text", "text": "styled words"}]
        }]),
        |doc| mark_paragraph_format(doc, "chg-fmt"),
        |store, doc_id| delete_in_paragraph(store, doc_id, 0, " words"),
    );
    assert_eq!(
        paragraph_bodies(&checkpoint),
        vec!["styled".to_string()],
        "checkpoint published the format mark or restored words: {checkpoint}"
    );
    assert_eq!(
        paragraph_bodies(&opened),
        vec!["{~~styled~~}{>>format:chg-fmt: add bold<<}".to_string()],
        "reopen dropped the format mark after the deletion: {opened}"
    );

    let (checkpoint, opened) = reopen_after_bot_edit(
        "bot-reopen-delete-word-later.draft",
        json!([
            {"type": "paragraph", "content": [{"type": "text", "text": "Keep the old phrase here."}]},
            {"type": "paragraph", "content": [{"type": "text", "text": "Keep the old phrase here. Extra."}]}
        ]),
        |doc| suggest_replacement(doc, "old phrase", "new phrase", "chg-rep"),
        |store, doc_id| delete_in_paragraph(store, doc_id, 0, "here"),
    );
    assert_eq!(
        paragraph_bodies(&checkpoint),
        vec![
            "Keep the old phrase .".to_string(),
            "Keep the old phrase here. Extra.".to_string(),
        ],
        "checkpoint changed the later paragraph: {checkpoint}"
    );
    assert_eq!(
        paragraph_bodies(&opened),
        vec![
            "Keep the {--old phrase--}{>>suggestion:chg-rep<<}{++new phrase++}{>>suggestion:chg-rep<<} .".to_string(),
            "Keep the old phrase here. Extra.".to_string(),
        ],
        "reopen put the replacement on the later paragraph: {opened}"
    );
}

/// Accept one suggestion and reject another on the same bot branch.
/// The branch stays open until both are decided, then merges once.
/// Main keeps the editor's text. The rejected wording stays only in the bot branch.
#[test]
fn mixed_decisions_merge_once_and_keep_main_text() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "bot-mixed-decisions.draft");
    set_chapter_plain(&store, &chapter.doc_id, "chapter start");
    svc.commit_now(
        &store,
        &m.id,
        "Baseline",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap()
    .expect("baseline");

    let doc = store.load_doc(&chapter.doc_id).unwrap();
    let since = state_vector(&doc);
    content::encode(
        &doc,
        &json!({"type":"doc","content":[{"type":"paragraph","content":[{
            "type":"text",
            "text":"rejected wording",
            "marks":[{"type":"suggestion_insert","attrs":{"id":"chg-drop","author":"agent:agent-test-1","ts":"t"}}]
        }]}]}),
    )
    .unwrap();
    let first_update = doc_update_since(&doc, &since);
    let mut drop_comment = sample_comment("c-drop", &chapter.id, "Drop this.");
    drop_comment.author.kind = "agent".into();
    drop_comment.author.id = "agent-test-1".into();
    drop_comment.author.name = "Line Editor".into();
    svc.record_bot_write(
        &store,
        &m.id,
        BotRetention {
            comment: Some(drop_comment.clone()),
            doc_id: Some(chapter.doc_id.clone()),
            doc_update: Some(first_update.clone()),
        },
        || {
            store
                .insert_comment(&m.id, &drop_comment)
                .map_err(|e| e.to_string())?;
            store
                .append_doc_update(&chapter.doc_id, &first_update)
                .map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        },
    )
    .unwrap();

    let doc = store.load_doc(&chapter.doc_id).unwrap();
    let since = state_vector(&doc);
    content::encode(
        &doc,
        &json!({"type":"doc","content":[{"type":"paragraph","content":[
            {
                "type":"text",
                "text":"rejected wording",
                "marks":[{"type":"suggestion_insert","attrs":{"id":"chg-drop","author":"agent:agent-test-1","ts":"t"}}]
            },
            {
                "type":"text",
                "text":" kept wording",
                "marks":[{"type":"suggestion_insert","attrs":{"id":"chg-keep","author":"agent:agent-test-1","ts":"t"}}]
            }
        ]}]}),
    )
    .unwrap();
    let second_update = doc_update_since(&doc, &since);
    let mut keep_comment = sample_comment("c-keep", &chapter.id, "Keep this.");
    keep_comment.author.kind = "agent".into();
    keep_comment.author.id = "agent-test-1".into();
    keep_comment.author.name = "Line Editor".into();
    svc.record_bot_write(
        &store,
        &m.id,
        BotRetention {
            comment: Some(keep_comment.clone()),
            doc_id: Some(chapter.doc_id.clone()),
            doc_update: Some(second_update.clone()),
        },
        || {
            store
                .insert_comment(&m.id, &keep_comment)
                .map_err(|e| e.to_string())?;
            store
                .append_doc_update(&chapter.doc_id, &second_update)
                .map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        },
    )
    .unwrap();
    svc.commit_bot_suggestion(
        &store,
        &m.id,
        "agent-test-1",
        "Line Editor",
        "Bot suggestions",
    )
    .unwrap()
    .expect("bot suggestions");

    svc.commit_review_decision(
        &store,
        &m.id,
        false,
        "Line Editor",
        &chapter.title,
        "author",
        Some("agent-test-1"),
        Some("chg-drop"),
        Some("suggestion_insert"),
        Some(&chapter.id),
    )
    .unwrap();
    assert!(
        svc.bot_branch_exists(&store, &m.id, "agent-test-1", "Line Editor")
            .unwrap(),
        "the branch merged while a suggestion was still open"
    );
    assert!(
        !svc.history(&store, &m.id, 12, 0)
            .unwrap()
            .iter()
            .any(|c| c.message.starts_with("Merged bot/")),
        "main merged the bot branch before every suggestion was decided"
    );
    let comments = store.comments_for_manuscript(&m.id).unwrap();
    assert!(comments
        .iter()
        .find(|c| c.id == "c-drop")
        .unwrap()
        .resolved_at
        .is_some());
    assert!(comments
        .iter()
        .find(|c| c.id == "c-keep")
        .unwrap()
        .resolved_at
        .is_none());

    set_chapter_plain(&store, &chapter.doc_id, "kept wording");
    svc.commit_review_decision(
        &store,
        &m.id,
        true,
        "Line Editor",
        &chapter.title,
        "author",
        Some("agent-test-1"),
        Some("chg-keep"),
        Some("suggestion_insert"),
        Some(&chapter.id),
    )
    .unwrap();
    assert!(svc
        .bot_branch_exists(&store, &m.id, "agent-test-1", "Line Editor")
        .is_err());
    assert!(svc
        .history(&store, &m.id, 12, 0)
        .unwrap()
        .iter()
        .any(|c| c.message.starts_with("Merged bot/")));

    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let main = repo.head_oid().unwrap().unwrap();
    let chapter_path = format!("chapters/{}.md", chapter.id);
    let head_md = String::from_utf8(
        repo.file_bytes(&main, &chapter_path)
            .unwrap()
            .expect("chapter"),
    )
    .unwrap();
    let editor = chapter_text(&store, &chapter.doc_id);
    assert!(
        head_md.contains("kept wording") && editor.contains("kept wording"),
        "main does not match the editor: main={head_md} editor={editor}"
    );
    assert!(
        !head_md.contains("rejected wording"),
        "rejected text landed on main: {head_md}"
    );
    let work_md = fs::read_to_string(svc.worktree_path(&m.id).join(&chapter_path)).unwrap();
    assert_eq!(work_md, head_md, "worktree chapter disagrees with HEAD");
    assert!(
        bot_history_contains(&repo, &chapter_path, "rejected wording"),
        "rejected text is missing from the bot branch history"
    );
    let changes = String::from_utf8(
        repo.file_bytes(&main, "review/changes.json")
            .unwrap()
            .expect("decisions"),
    )
    .unwrap();
    assert_eq!(
        change_status(&changes, "chg-drop").as_deref(),
        Some("rejected")
    );
    assert_eq!(
        change_status(&changes, "chg-keep").as_deref(),
        Some("accepted")
    );
    let draft_path = store.draft_file_path(&m.id).unwrap().unwrap();
    let opened = svc
        .open_draft_path(&store, &draft_path, true)
        .unwrap()
        .unwrap();
    assert!(
        opened.recovery.is_none(),
        "reopen asked to save a newer copy"
    );
    let decisions = store.review_decisions_for_manuscript(&m.id).unwrap();
    let rows: Vec<_> = decisions.values().flatten().collect();
    assert!(rows
        .iter()
        .any(|row| row.id == "chg-drop" && row.status == "rejected"));
    assert!(rows
        .iter()
        .any(|row| row.id == "chg-keep" && row.status == "accepted"));
    let comments = store.comments_for_manuscript(&m.id).unwrap();
    assert!(comments
        .iter()
        .find(|c| c.id == "c-drop")
        .unwrap()
        .resolved_at
        .is_some());
    assert!(comments
        .iter()
        .find(|c| c.id == "c-keep")
        .unwrap()
        .resolved_at
        .is_none());
}

/// A reply shares the bot comment's thread file. The checkpoint leaves the bot
/// note off main, so the merge has to keep that reply and any tombstone already
/// in the file. Deleting the database and reopening still finds the reply.
#[test]
fn reply_on_the_bot_thread_survives_accept() {
    let (dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "bot-thread-reply.draft");
    set_chapter_plain(&store, &chapter.doc_id, "chapter start");
    svc.commit_now(
        &store,
        &m.id,
        "Baseline",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap()
    .expect("baseline");
    set_chapter_mark(&store, &chapter.doc_id, "chg-bot", "suggested wording");
    let mut bot = sample_comment("c-bot", &chapter.id, "Bot note.");
    bot.author.kind = "agent".into();
    bot.author.id = "agent-test-1".into();
    bot.author.name = "Line Editor".into();
    store.insert_comment(&m.id, &bot).unwrap();
    svc.commit_bot_suggestion(&store, &m.id, "agent-test-1", "Line Editor", "Bot comment")
        .unwrap()
        .expect("bot comment");
    store
        .human_comment_reply(
            &m.id,
            &chapter.id,
            "c-bot",
            "Writer reply.",
            "Author",
            "local",
        )
        .unwrap();
    let mut removed = sample_comment("c-removed", &chapter.id, "Removed reply.");
    removed.thread_id = Some("c-bot".into());
    removed.created_at = "2026-01-01T00:00:02.000Z".into();
    store.insert_comment(&m.id, &removed).unwrap();
    store.tombstone_comment(&m.id, "c-removed").unwrap();
    svc.commit_now(
        &store,
        &m.id,
        "Checkpoint",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap()
    .expect("checkpoint");
    svc.commit_review_decision(
        &store,
        &m.id,
        true,
        "Line Editor",
        &chapter.title,
        "author",
        Some("agent-test-1"),
        Some("chg-bot"),
        Some("suggestion_insert"),
        Some(&chapter.id),
    )
    .unwrap();
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let main = repo.head_oid().unwrap().unwrap();
    let merged = String::from_utf8(
        repo.file_bytes(&main, "comments/c-bot.json")
            .unwrap()
            .expect("thread file"),
    )
    .unwrap();
    assert!(
        merged.contains("Writer reply."),
        "the merge dropped the reply: {merged}"
    );
    assert!(
        merged.contains("Bot note."),
        "the merge dropped the bot note: {merged}"
    );
    assert!(
        merged.contains("Removed reply.") && merged.contains("\"deletedAt\""),
        "the merge dropped the reply tombstone: {merged}"
    );
    let draft_path = store.draft_file_path(&m.id).unwrap().unwrap();
    let data = dir.path().to_path_buf();
    drop(store);
    drop(svc);
    drop(repo);
    for name in ["swarmdraft.db", "swarmdraft.db-wal", "swarmdraft.db-shm"] {
        let path = data.join(name);
        if path.exists() {
            fs::remove_file(&path).unwrap();
        }
    }
    let store = Store::open(&data).unwrap();
    let svc = DraftService::new(data, "0.2.1".into());
    let opened = svc
        .open_draft_path(&store, &draft_path, true)
        .unwrap()
        .unwrap();
    let comments = store
        .comments_for_manuscript(&opened.manuscript_id)
        .unwrap();
    assert!(
        comments.iter().any(|c| c.body == "Writer reply."),
        "reopen lost the reply: {comments:?}"
    );
    assert!(
        comments
            .iter()
            .any(|c| c.id == "c-bot" && c.body == "Bot note."),
        "reopen lost the bot note: {comments:?}"
    );
    assert!(comments.iter().all(|c| c.id != "c-removed"));
    let tombs = store.comment_tombstones(&opened.manuscript_id).unwrap();
    assert!(
        tombs
            .iter()
            .any(|row| row.comment.id == "c-removed" && row.comment.body == "Removed reply."),
        "reopen lost the reply tombstone: {tombs:?}"
    );
}

fn agent_comment(id: &str, section_id: &str, body: &str) -> Comment {
    let mut comment = sample_comment(id, section_id, body);
    comment.author.kind = "agent".into();
    comment.author.id = "agent-test-1".into();
    comment.author.name = "Line Editor".into();
    comment
}

fn marks_doc(marks: &[(&str, &str)]) -> serde_json::Value {
    let content: Vec<_> = marks
        .iter()
        .map(|(id, text)| {
            json!({
                "type": "text",
                "text": text,
                "marks": [{
                    "type": "suggestion_insert",
                    "attrs": {"id": id, "author": "agent:agent-test-1", "ts": "t"}
                }]
            })
        })
        .collect();
    json!({"type":"doc","content":[{"type":"paragraph","content": content}]})
}

fn bot_comment_resolved_at(repo: &DraftRepo, comment_id: &str) -> Option<String> {
    for tip in repo.search_ref_tips().unwrap() {
        if !tip.name.starts_with("bot/") {
            continue;
        }
        let Some(bytes) = repo
            .file_bytes(&tip.oid, &format!("comments/{comment_id}.json"))
            .unwrap()
        else {
            continue;
        };
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let Some(rows) = value.get("rows").and_then(|rows| rows.as_array()) else {
            continue;
        };
        for row in rows {
            if row.get("id").and_then(|id| id.as_str()) == Some(comment_id) {
                return row
                    .get("resolvedAt")
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string());
            }
        }
    }
    None
}

fn drop_database(dir: &Path) {
    for name in ["swarmdraft.db", "swarmdraft.db-wal", "swarmdraft.db-shm"] {
        let path = dir.join(name);
        if path.exists() {
            fs::remove_file(path).unwrap();
        }
    }
}

/// Resolving a bot comment has to land on the bot branch. Main omits that file,
/// so a rebuild otherwise restores the comment still open.
#[test]
fn resolving_a_bot_comment_stays_resolved_after_reopen() {
    let (dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "bot-resolve.draft");
    svc.commit_now(
        &store,
        &m.id,
        "Baseline",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap()
    .expect("baseline");
    let comment = agent_comment("c-bot", &chapter.id, "Bot note.");
    store.insert_comment(&m.id, &comment).unwrap();
    svc.commit_bot_suggestion(&store, &m.id, "agent-test-1", "Line Editor", "Bot comment")
        .unwrap()
        .expect("bot comment");
    store
        .set_comment_thread_resolved(&m.id, &chapter.id, "c-bot", true)
        .unwrap();
    svc.commit_now(
        &store,
        &m.id,
        "Resolved comment",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap();
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    assert!(
        bot_comment_resolved_at(&repo, "c-bot").is_some(),
        "the resolve never reached the bot branch"
    );
    let draft_path = store.draft_file_path(&m.id).unwrap().unwrap();
    let data = dir.path().to_path_buf();
    drop(repo);
    drop(svc);
    drop(store);
    drop_database(&data);
    let store = Store::open(&data).unwrap();
    let svc = DraftService::new(data, "0.2.1".into());
    let opened = svc
        .open_draft_path(&store, &draft_path, true)
        .unwrap()
        .unwrap();
    let comment = store
        .comments_for_manuscript(&opened.manuscript_id)
        .unwrap()
        .into_iter()
        .find(|row| row.id == "c-bot")
        .expect("bot comment");
    assert!(
        comment.resolved_at.is_some(),
        "reopen showed the resolved bot comment as open"
    );
}

/// Bot B's branch exists first. Bot A's comment merges onto main. B commits again
/// and the snapshot copies that comment. The next checkpoint has to leave it on
/// main, and a resolve has to survive deleting the database.
#[test]
fn merged_comment_stays_resolved_after_another_bot_commits() {
    let (dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "two-bots.draft");
    set_chapter_plain(&store, &chapter.doc_id, "chapter start");
    svc.commit_now(
        &store,
        &m.id,
        "Baseline",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap()
    .expect("baseline");

    set_chapter_authored_marks(
        &store,
        &chapter.doc_id,
        &[("chg-b", "still open", "agent:b-bot")],
    );
    svc.commit_bot_suggestion(&store, &m.id, "b-bot", "Copy Editor", "Bot B suggestion")
        .unwrap()
        .expect("bot B branch");
    assert!(svc
        .bot_branch_exists(&store, &m.id, "b-bot", "Copy Editor")
        .unwrap());

    set_chapter_authored_marks(
        &store,
        &chapter.doc_id,
        &[("chg-a", "from a", "agent:a-bot")],
    );
    let mut comment = sample_comment("c-a", &chapter.id, "Note from A.");
    comment.author.kind = "agent".into();
    comment.author.id = "a-bot".into();
    comment.author.name = "Line Editor".into();
    store.insert_comment(&m.id, &comment).unwrap();
    svc.commit_bot_suggestion(&store, &m.id, "a-bot", "Line Editor", "Bot A comment")
        .unwrap()
        .expect("bot A comment");
    set_chapter_plain(&store, &chapter.doc_id, "from a");
    svc.commit_review_decision(
        &store,
        &m.id,
        true,
        "Line Editor",
        &chapter.title,
        "author",
        Some("a-bot"),
        Some("chg-a"),
        Some("suggestion_insert"),
        Some(&chapter.id),
    )
    .unwrap();
    assert!(svc
        .bot_branch_exists(&store, &m.id, "a-bot", "Line Editor")
        .is_err());
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let main = repo.head_oid().unwrap().unwrap();
    assert!(
        repo.file_bytes(&main, "comments/c-a.json")
            .unwrap()
            .is_some(),
        "A's merge did not put the comment on main"
    );
    let changes = String::from_utf8(
        repo.file_bytes(&main, "review/changes.json")
            .unwrap()
            .expect("decisions"),
    )
    .unwrap();
    assert_eq!(
        change_status(&changes, "chg-a").as_deref(),
        Some("accepted")
    );
    drop(repo);

    // Put the suggestion mark back so the other bot's snapshot records this
    // decision as the agent's. The checkpoint has to keep it on main anyway.
    set_chapter_authored_marks(
        &store,
        &chapter.doc_id,
        &[("chg-a", "from a", "agent:a-bot")],
    );
    svc.commit_bot_suggestion(&store, &m.id, "b-bot", "Copy Editor", "Bot B again")
        .unwrap()
        .expect("bot B copied the cache");
    svc.commit_now(
        &store,
        &m.id,
        "Checkpoint",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap()
    .expect("checkpoint");
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let main = repo.head_oid().unwrap().unwrap();
    let comment_file = repo
        .file_bytes(&main, "comments/c-a.json")
        .unwrap()
        .expect("checkpoint deleted the merged comment");
    assert!(
        String::from_utf8_lossy(&comment_file).contains("Note from A."),
        "checkpoint rewrote the merged comment"
    );
    let changes = String::from_utf8(
        repo.file_bytes(&main, "review/changes.json")
            .unwrap()
            .expect("decisions"),
    )
    .unwrap();
    assert_eq!(
        change_status(&changes, "chg-a").as_deref(),
        Some("accepted"),
        "checkpoint dropped the decision already on main: {changes}"
    );
    drop(repo);

    store
        .set_comment_thread_resolved(&m.id, &chapter.id, "c-a", true)
        .unwrap();
    svc.commit_now(
        &store,
        &m.id,
        "Resolved comment",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap()
    .expect("resolve");
    let draft_path = store.draft_file_path(&m.id).unwrap().unwrap();
    let data = dir.path().to_path_buf();
    drop(svc);
    drop(store);
    drop_database(&data);
    let store = Store::open(&data).unwrap();
    let svc = DraftService::new(data, "0.2.1".into());
    let opened = svc
        .open_draft_path(&store, &draft_path, true)
        .unwrap()
        .unwrap();
    let comment = store
        .comments_for_manuscript(&opened.manuscript_id)
        .unwrap()
        .into_iter()
        .find(|row| row.id == "c-a")
        .expect("merged comment");
    assert!(
        comment.resolved_at.is_some(),
        "reopen showed the resolved comment as open"
    );
    let decisions = store
        .review_decisions_for_manuscript(&opened.manuscript_id)
        .unwrap();
    let rows: Vec<_> = decisions.values().flatten().collect();
    assert!(
        rows.iter()
            .any(|row| row.id == "chg-a" && row.status == "accepted"),
        "reopen lost the decision already on main: {rows:?}"
    );
}

/// A reject writes `resolvedAt` on the bot branch. A reply that reopens the thread
/// has to clear it there before the other suggestion is decided, or a rebuild
/// shows the comment resolved again.
#[test]
fn reply_after_one_reject_reopens_the_bot_comment() {
    let (dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "bot-reopen-reply.draft");
    set_chapter_plain(&store, &chapter.doc_id, "chapter start");
    svc.commit_now(
        &store,
        &m.id,
        "Baseline",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap()
    .expect("baseline");

    let doc = store.load_doc(&chapter.doc_id).unwrap();
    let since = state_vector(&doc);
    content::encode(&doc, &marks_doc(&[("chg-a", "first")])).unwrap();
    let update_a = doc_update_since(&doc, &since);
    let comment_a = agent_comment("c-a", &chapter.id, "Comment on the first.");
    let doc_id = chapter.doc_id.clone();
    svc.record_bot_write(
        &store,
        &m.id,
        BotRetention {
            comment: Some(comment_a.clone()),
            doc_id: Some(doc_id.clone()),
            doc_update: Some(update_a.clone()),
        },
        || {
            store
                .insert_comment(&m.id, &comment_a)
                .map_err(|e| e.to_string())?;
            store
                .append_doc_update(&doc_id, &update_a)
                .map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        },
    )
    .unwrap();

    let doc = store.load_doc(&chapter.doc_id).unwrap();
    let since = state_vector(&doc);
    content::encode(&doc, &marks_doc(&[("chg-a", "first"), ("chg-b", "second")])).unwrap();
    let update_b = doc_update_since(&doc, &since);
    let comment_b = agent_comment("c-b", &chapter.id, "Comment on the second.");
    svc.record_bot_write(
        &store,
        &m.id,
        BotRetention {
            comment: Some(comment_b.clone()),
            doc_id: Some(doc_id.clone()),
            doc_update: Some(update_b.clone()),
        },
        || {
            store
                .insert_comment(&m.id, &comment_b)
                .map_err(|e| e.to_string())?;
            store
                .append_doc_update(&doc_id, &update_b)
                .map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        },
    )
    .unwrap();
    svc.commit_bot_suggestion(&store, &m.id, "agent-test-1", "Line Editor", "Bot comments")
        .unwrap()
        .expect("bot comments");
    svc.commit_review_decision(
        &store,
        &m.id,
        false,
        "Line Editor",
        &chapter.title,
        "author",
        Some("agent-test-1"),
        Some("chg-a"),
        Some("suggestion_insert"),
        Some(&chapter.id),
    )
    .unwrap();
    assert!(svc
        .bot_branch_exists(&store, &m.id, "agent-test-1", "Line Editor")
        .unwrap());
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    assert!(
        bot_comment_resolved_at(&repo, "c-a").is_some(),
        "reject did not record resolvedAt on the bot branch"
    );
    drop(repo);
    store
        .human_comment_reply(
            &m.id,
            &chapter.id,
            "c-a",
            "Writer reply.",
            "Author",
            "local",
        )
        .unwrap();
    svc.commit_now(
        &store,
        &m.id,
        "Reopened comment",
        "Author",
        "author@swarmdraft.local",
    )
    .unwrap()
    .expect("reply commit");
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    assert!(
        bot_comment_resolved_at(&repo, "c-a").is_none(),
        "the reply left the bot comment resolved"
    );
    let draft_path = store.draft_file_path(&m.id).unwrap().unwrap();
    let data = dir.path().to_path_buf();
    drop(repo);
    drop(svc);
    drop(store);
    drop_database(&data);
    let store = Store::open(&data).unwrap();
    let svc = DraftService::new(data, "0.2.1".into());
    let opened = svc
        .open_draft_path(&store, &draft_path, true)
        .unwrap()
        .unwrap();
    let comments = store
        .comments_for_manuscript(&opened.manuscript_id)
        .unwrap();
    let reopened = comments
        .iter()
        .find(|row| row.id == "c-a")
        .expect("bot comment");
    assert!(
        reopened.resolved_at.is_none(),
        "reopen showed the replied thread resolved"
    );
    assert!(comments.iter().any(|row| row.body == "Writer reply."));
    assert!(comments
        .iter()
        .any(|row| row.id == "c-b" && row.resolved_at.is_none()));
}

fn bot_history_contains(repo: &DraftRepo, path: &str, needle: &str) -> bool {
    for tip in repo.search_ref_tips().unwrap() {
        if !tip.name.starts_with("bot/") {
            continue;
        }
        for commit in repo.walk_first_parent(&tip.oid).unwrap() {
            if let Some(bytes) = repo.file_bytes(&commit.oid, path).unwrap() {
                if String::from_utf8_lossy(&bytes).contains(needle) {
                    return true;
                }
            }
        }
    }
    false
}

fn set_chapter_authored_marks(store: &Store, doc_id: &str, marks: &[(&str, &str, &str)]) {
    let content: Vec<_> = marks
        .iter()
        .map(|(id, text, author)| {
            json!({
                "type": "text",
                "text": text,
                "marks": [{
                    "type": "suggestion_insert",
                    "attrs": {"id": id, "author": author, "ts": "t"}
                }]
            })
        })
        .collect();
    let doc = content::new_doc();
    content::encode(
        &doc,
        &json!({"type":"doc","content":[{"type":"paragraph","content": content}]}),
    )
    .unwrap();
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    store.replace_doc_state(doc_id, &state).unwrap();
}

fn set_chapter_marks(store: &Store, doc_id: &str, marks: &[(&str, &str)]) {
    let content: Vec<_> = marks
        .iter()
        .map(|(id, text)| {
            json!({
                "type": "text",
                "text": text,
                "marks": [{
                    "type": "suggestion_insert",
                    "attrs": {"id": id, "author": "agent:agent-test-1", "ts": "t"}
                }]
            })
        })
        .collect();
    let doc = content::new_doc();
    content::encode(
        &doc,
        &json!({"type":"doc","content":[{"type":"paragraph","content": content}]}),
    )
    .unwrap();
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    store.replace_doc_state(doc_id, &state).unwrap();
}

#[test]
fn restore_before_a_later_chapter_keeps_its_comment_and_decision() {
    let (dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored).clone();
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "restore-later-chapter.draft");
    set_chapter_plain(&store, &chapter.doc_id, "version-one");
    let first = svc
        .commit_now(&store, &m.id, "First", "Author", "author@swarmdraft.local")
        .unwrap()
        .expect("first");
    let added = store.add_section(&m.id, "chapter", "Later", None).unwrap();
    set_chapter_mark(&store, &added.doc_id, "chg-added", "new chapter");
    store
        .insert_comment(
            &m.id,
            &sample_comment("c-added", &added.id, "On the later chapter."),
        )
        .unwrap();
    svc.commit_review_decision(
        &store,
        &m.id,
        true,
        "Line Editor",
        &added.title,
        "author",
        None,
        Some("chg-added"),
        Some("suggestion_insert"),
        Some(&added.id),
    )
    .unwrap()
    .expect("accept");
    svc.restore(&store, &m.id, &first, "Author")
        .expect("restore finishes when the decision names a removed chapter");
    assert!(chapter_text(&store, &chapter.doc_id).contains("version-one"));
    assert!(store
        .list_sections(&m.id)
        .unwrap()
        .iter()
        .all(|s| s.id != added.id));
    let comment = store
        .comments_for_manuscript(&m.id)
        .unwrap()
        .into_iter()
        .find(|c| c.id == "c-added")
        .expect("comment stays in the cache");
    assert_eq!(comment.body, "On the later chapter.");
    let kept = store
        .review_decisions_for_manuscript(&m.id)
        .unwrap()
        .get(&added.id)
        .expect("decision stays in the cache")
        .iter()
        .find(|row| row.id == "chg-added")
        .unwrap()
        .clone();
    assert_eq!(kept.status, "accepted");
    set_chapter_plain(&store, &chapter.doc_id, "after restore");
    let follow = svc
        .commit_now(
            &store,
            &m.id,
            "After restore",
            "Author",
            "author@swarmdraft.local",
        )
        .unwrap()
        .expect("next commit");
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let book = String::from_utf8(repo.file_bytes(&follow, "book.json").unwrap().unwrap()).unwrap();
    assert!(!book.contains(&added.id));
    let comment_file = String::from_utf8(
        repo.file_bytes(&follow, "comments/c-added.json")
            .unwrap()
            .expect("comment stays in git"),
    )
    .unwrap();
    assert!(comment_file.contains("On the later chapter."));
    let changes = String::from_utf8(
        repo.file_bytes(&follow, "review/changes.json")
            .unwrap()
            .expect("decision stays in git"),
    )
    .unwrap();
    assert!(changes.contains("chg-added"));
    assert!(changes.contains(&added.id));
    assert!(changes.contains("\"status\": \"accepted\""));

    let draft_path = store.draft_file_path(&m.id).unwrap().unwrap();
    let data = dir.path().to_path_buf();
    drop(store);
    drop(svc);
    for name in ["swarmdraft.db", "swarmdraft.db-wal", "swarmdraft.db-shm"] {
        let path = data.join(name);
        if path.exists() {
            fs::remove_file(&path).unwrap();
        }
    }
    let store2 = Store::open(&data).unwrap();
    let svc2 = DraftService::new(data, "0.2.1".into());
    let opened = svc2
        .open_draft_path(&store2, &draft_path, true)
        .unwrap()
        .unwrap();
    assert!(store2
        .list_sections(&opened.manuscript_id)
        .unwrap()
        .iter()
        .all(|s| s.id != added.id));
    assert!(store2
        .comments_for_manuscript(&opened.manuscript_id)
        .unwrap()
        .iter()
        .any(|c| c.id == "c-added" && c.body == "On the later chapter."));
    assert!(store2
        .review_decisions_for_manuscript(&opened.manuscript_id)
        .unwrap()
        .get(&added.id)
        .expect("reopen restores the decision")
        .iter()
        .any(|row| row.id == "chg-added" && row.status == "accepted"));
}
