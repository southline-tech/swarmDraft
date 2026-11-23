//! History panel feed (#365).

use serde_json::json;
use swarmdraft_lib::content;
use swarmdraft_lib::draft::{
    DraftRepo, DraftService, HistoryBotSuggestion, HistoryFeedEntry, HistoryFeedResponse,
};
use swarmdraft_lib::manuscripts::{section_doc_id, OutlineEntry, Section};
use swarmdraft_lib::storage::Store;
use tempfile::tempdir;
use yrs::{ReadTxn, StateVector, Transact};

fn temp_store() -> (tempfile::TempDir, Store) {
    let dir = tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    (dir, store)
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

fn chapter(stored: &swarmdraft_lib::manuscripts::StoredManuscript) -> &Section {
    &stored
        .sections
        .iter()
        .find(|s| s.section.kind == "chapter")
        .unwrap()
        .section
}

fn link_draft(store: &Store, manuscript_id: &str, name: &str) {
    let path = store.data_dir().join("drafts").join(name);
    store
        .set_draft_file_path(manuscript_id, &path.to_string_lossy())
        .unwrap();
}

#[test]
fn history_feed_json_uses_snake_case_variant_fields() {
    let entry = HistoryFeedEntry::AuthorEdit {
        oid: "abc".into(),
        time_unix: 1_700_000_000,
        chapter_title: "Chapter Two".into(),
        collapsed_count: 1,
    };
    let value = serde_json::to_value(&entry).unwrap();
    assert_eq!(value["kind"], "authorEdit", "author edit json: {value}");
    assert_eq!(
        value["time_unix"], 1_700_000_000,
        "author edit json: {value}"
    );
    assert_eq!(
        value["chapter_title"], "Chapter Two",
        "author edit json: {value}"
    );
    assert!(value.get("timeUnix").is_none(), "author edit json: {value}");
    assert!(
        value.get("chapterTitle").is_none(),
        "author edit json: {value}"
    );

    let response = HistoryFeedResponse {
        entries: vec![entry],
        filter_authors: Vec::new(),
        word_count_now: 30,
        save_state: "saved".into(),
    };
    let raw = serde_json::to_value(&response).unwrap();
    assert!(raw.get("filterAuthors").is_some(), "feed json: {raw}");
    assert!(raw.get("wordCountNow").is_some(), "feed json: {raw}");
    assert!(raw.get("entries").is_some(), "feed json: {raw}");

    let suggestion = HistoryBotSuggestion {
        change_id: "c1".into(),
        status: "accepted".into(),
        quote: "Hello".into(),
        decided_by: None,
        section_id: "s1".into(),
        chapter_title: "Chapter Two".into(),
    };
    let suggestion_json = serde_json::to_value(&suggestion).unwrap();
    assert_eq!(suggestion_json["changeId"], "c1", "{suggestion_json}");
    assert_eq!(
        suggestion_json["chapterTitle"], "Chapter Two",
        "{suggestion_json}"
    );
    assert!(
        suggestion_json.get("change_id").is_none(),
        "{suggestion_json}"
    );
}

#[test]
fn new_chapter_text_survives_checkpoint_without_writing_draft() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "new-chapter.draft");
    let draft_path = store.draft_file_path(&m.id).unwrap().expect("linked path");
    svc.commit_now(&store, &m.id, "Saved", "Author", "author@swarmdraft.local")
        .unwrap();
    let draft_before = std::fs::read(&draft_path).ok();

    let existing = store.list_sections(&m.id).unwrap();
    let new_id = "chapter-two";
    let new_doc = section_doc_id(&m.id, new_id);
    let mut outline: Vec<OutlineEntry> = existing
        .iter()
        .map(|section| OutlineEntry {
            id: section.id.clone(),
            parent_id: section.parent_id.clone(),
            kind: section.kind.clone(),
            title: section.title.clone(),
            doc_id: section.doc_id.clone(),
        })
        .collect();
    outline.push(OutlineEntry {
        id: new_id.into(),
        parent_id: None,
        kind: "chapter".into(),
        title: "Chapter Two".into(),
        doc_id: new_doc.clone(),
    });
    store.save_outline(&m.id, &outline).unwrap();
    set_chapter_plain(&store, &new_doc, "typed after the split");
    svc.checkpoint_if_due(&store, &m.id, "Edited Chapter Two", true)
        .unwrap()
        .expect("checkpoint commit");

    assert_eq!(
        std::fs::read(&draft_path).ok(),
        draft_before,
        "a checkpoint must not rewrite the .draft file"
    );
    let markdown = std::fs::read_to_string(
        svc.worktree_path(&m.id)
            .join("chapters")
            .join(format!("{new_id}.md")),
    )
    .unwrap();
    assert!(
        markdown.contains("typed after the split"),
        "git chapter file: {markdown}"
    );

    set_chapter_plain(&store, &new_doc, "wiped");
    let bin = std::fs::read(
        svc.worktree_path(&m.id)
            .join("yjs")
            .join(format!("{new_id}.bin")),
    )
    .unwrap();
    store.replace_doc_state(&new_doc, &bin).unwrap();
    let restored = store.load_doc(&new_doc).unwrap();
    let text = content::markdown(&content::decode(&restored));
    assert!(
        text.contains("typed after the split"),
        "reloaded from git bytes: {text}"
    );
    assert!(!text.contains("wiped"));

    let feed = svc.history_feed(&store, &m.id, 20).unwrap();
    assert!(feed.entries.iter().any(|entry| matches!(
        entry,
        HistoryFeedEntry::AuthorEdit { chapter_title, .. } if chapter_title == "Chapter Two"
    )));
}

#[test]
fn feed_collapses_consecutive_chapter_edits() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "history-collapse.draft");
    let chapter = chapter(&stored);
    for version in ["v1", "v2", "v3"] {
        set_chapter_plain(&store, &chapter.doc_id, version);
        svc.commit_now(
            &store,
            &m.id,
            "Edited chapter",
            "Author",
            "author@swarmdraft.local",
        )
        .unwrap()
        .expect("chapter edit commit");
    }
    set_chapter_plain(&store, &chapter.doc_id, "v3 saved");
    svc.commit_now(&store, &m.id, "Saved", "Author", "author@swarmdraft.local")
        .unwrap()
        .expect("explicit save");

    let feed = svc.history_feed(&store, &m.id, 20).unwrap();
    let edits: Vec<_> = feed
        .entries
        .iter()
        .filter(|e| matches!(e, HistoryFeedEntry::AuthorEdit { .. }))
        .collect();
    assert_eq!(
        edits.len(),
        1,
        "idle autosaves collapsed: {:?}",
        feed.entries
    );
    if let HistoryFeedEntry::AuthorEdit {
        collapsed_count, ..
    } = edits[0]
    {
        assert!(*collapsed_count >= 2, "counted collapsed checkpoints");
    }
    assert!(feed
        .entries
        .iter()
        .any(|e| matches!(e, HistoryFeedEntry::Save { .. })));
}

#[test]
fn feed_lists_bot_merge_with_suggestions() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "history-bot.draft");
    store.create_agent("Line Editor", "#3366ff").unwrap();
    set_chapter_plain(&store, &chapter.doc_id, "harbor");
    svc.commit_now(&store, &m.id, "Saved", "Author", "author@swarmdraft.local")
        .unwrap();
    svc.commit_review_decision(
        &store,
        &m.id,
        true,
        "Line Editor",
        chapter.title.as_str(),
        "Author",
        Some("bot-1"),
        Some("chg-hist-1"),
        Some("suggestion_insert"),
        Some(chapter.id.as_str()),
    )
    .unwrap()
    .expect("decision commit");

    let feed = svc.history_feed(&store, &m.id, 20).unwrap();
    let bot = feed
        .entries
        .iter()
        .find_map(|e| match e {
            HistoryFeedEntry::Bot {
                agent_name,
                suggestions,
                ..
            } => Some((agent_name.clone(), suggestions.clone())),
            _ => None,
        })
        .expect("bot entry");
    assert_eq!(bot.0, "Line Editor");
    assert!(
        bot.1
            .iter()
            .any(|s| s.change_id == "chg-hist-1" && s.status == "accepted"),
        "suggestion rows: {:?}",
        bot.1
    );
}

#[test]
fn compare_reports_word_delta() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "history-compare.draft");
    set_chapter_plain(&store, &chapter.doc_id, "one two three");
    let oid = svc
        .commit_now(&store, &m.id, "Saved", "Author", "author@swarmdraft.local")
        .unwrap()
        .expect("saved");
    set_chapter_plain(&store, &chapter.doc_id, "one two three four five");
    svc.commit_now(&store, &m.id, "Saved", "Author", "author@swarmdraft.local")
        .unwrap();

    let cmp = svc.history_compare(&store, &m.id, &oid, false).unwrap();
    assert!(cmp.total_words_now >= cmp.total_words_then);
    assert!(
        cmp.sections.iter().any(|s| s.added >= 2),
        "sections: {:?}",
        cmp.sections
    );
}

#[test]
fn restore_version_tags_milestone_before_restore() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let chapter = chapter(&stored);
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "history-restore.draft");
    set_chapter_plain(&store, &chapter.doc_id, "baseline");
    let baseline = svc
        .commit_now(&store, &m.id, "Saved", "Author", "author@swarmdraft.local")
        .unwrap()
        .expect("baseline");
    set_chapter_plain(&store, &chapter.doc_id, "later");
    svc.commit_now(&store, &m.id, "Saved", "Author", "author@swarmdraft.local")
        .unwrap();

    let outcome = svc
        .restore_version(&store, &m.id, &baseline, "Author", Some(0))
        .unwrap();
    assert!(outcome
        .milestone_name
        .as_deref()
        .unwrap()
        .starts_with("Before restoring"));
    let repo = DraftRepo::open_working(&svc.worktree_path(&m.id)).unwrap();
    let tags = repo.list_milestone_tags().unwrap();
    assert!(
        tags.iter().any(|t| t.name.starts_with("Before restoring")),
        "tags: {:?}",
        tags
    );
    assert_ne!(outcome.oid, baseline);
}

#[test]
fn milestone_create_and_list() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "history-milestone.draft");
    svc.commit_now(&store, &m.id, "Saved", "Author", "author@swarmdraft.local")
        .unwrap();
    svc.milestone_create(&store, &m.id, "Submitted to editor", None, "Author")
        .unwrap();
    let listed = svc.milestone_list(&m.id).unwrap();
    assert!(listed.iter().any(|t| t.name == "Submitted to editor"));
    let feed = svc.history_feed(&store, &m.id, 20).unwrap();
    assert!(feed.entries.iter().any(|e| {
        matches!(
            e,
            HistoryFeedEntry::Milestone { name, .. } if name == "Submitted to editor"
        )
    }));
    svc.milestone_remove(&m.id, "Submitted to editor").unwrap();
    assert!(svc
        .milestone_list(&m.id)
        .unwrap()
        .iter()
        .all(|t| t.name != "Submitted to editor"));
}
