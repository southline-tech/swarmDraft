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

fn set_doc_json(store: &Store, doc_id: &str, content: serde_json::Value) {
    let doc = content::new_doc();
    content::encode(&doc, &json!({ "type": "doc", "content": content })).unwrap();
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    store.replace_doc_state(doc_id, &state).unwrap();
}

fn set_paragraphs(store: &Store, doc_id: &str, lines: &[&str]) {
    let doc = content::new_doc();
    let content: Vec<_> = lines
        .iter()
        .map(|text| {
            json!({
                "type": "paragraph",
                "content": [{ "type": "text", "text": text }]
            })
        })
        .collect();
    content::encode(&doc, &json!({ "type": "doc", "content": content })).unwrap();
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    store.replace_doc_state(doc_id, &state).unwrap();
}

fn rewrite_paragraph(store: &Store, doc_id: &str, index: usize, next: &str) {
    use yrs::{Text, Transact, XmlFragment, XmlOut};
    let doc = store.load_doc(doc_id).unwrap();
    let text = {
        let frag = doc.get_or_insert_xml_fragment(content::FRAGMENT);
        let txn = doc.transact();
        let children: Vec<_> = frag.children(&txn).collect();
        let XmlOut::Element(el) = &children[index] else {
            panic!("paragraph {index} missing");
        };
        let inner: Vec<_> = el.children(&txn).collect();
        let XmlOut::Text(text) = &inner[0] else {
            panic!("paragraph {index} has no text");
        };
        text.clone()
    };
    {
        let mut txn = doc.transact_mut();
        let len = text.len(&txn);
        if len > 0 {
            text.remove_range(&mut txn, 0, len);
        }
        text.insert(&mut txn, 0, next);
    }
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    store.replace_doc_state(doc_id, &state).unwrap();
}

fn append_paragraph(store: &Store, doc_id: &str, text: &str) {
    use yrs::{Text, Transact, XmlElementPrelim, XmlFragment, XmlTextPrelim};
    let doc = store.load_doc(doc_id).unwrap();
    {
        let frag = doc.get_or_insert_xml_fragment(content::FRAGMENT);
        let mut txn = doc.transact_mut();
        let el = frag.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
        let node = el.push_back(&mut txn, XmlTextPrelim::new(""));
        node.insert(&mut txn, 0, text);
    }
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    store.replace_doc_state(doc_id, &state).unwrap();
}

fn outline_of(store: &Store, manuscript_id: &str) -> Vec<OutlineEntry> {
    store
        .list_sections(manuscript_id)
        .unwrap()
        .into_iter()
        .map(|section| OutlineEntry {
            id: section.id,
            parent_id: section.parent_id,
            kind: section.kind,
            title: section.title,
            doc_id: section.doc_id,
        })
        .collect()
}

#[test]
fn feed_keeps_one_current_entry_and_lists_saves() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "history-one-current.draft");
    let chapter = chapter(&stored);
    set_paragraphs(&store, &chapter.doc_id, &["one two"]);
    svc.commit_now(&store, &m.id, "Saved", "Author", "author@swarmdraft.local")
        .unwrap();
    set_paragraphs(&store, &chapter.doc_id, &["one two three"]);
    svc.commit_now(&store, &m.id, "Saved", "Author", "author@swarmdraft.local")
        .unwrap();

    let feed = svc.history_feed(&store, &m.id, 20).unwrap();
    let currents = feed
        .entries
        .iter()
        .filter(|entry| matches!(entry, HistoryFeedEntry::Current { .. }))
        .count();
    assert_eq!(currents, 1, "entries: {:?}", feed.entries);
    assert!(matches!(
        feed.entries.first(),
        Some(HistoryFeedEntry::Current { .. })
    ));
    let saves = feed
        .entries
        .iter()
        .filter(|entry| matches!(entry, HistoryFeedEntry::Save { .. }))
        .count();
    assert!(
        saves >= 2,
        "saves should stay save rows: {:?}",
        feed.entries
    );
}

#[test]
fn compare_keeps_chapters_and_paragraphs_without_block_markers() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "history-compare-paragraphs.draft");
    let chapter = chapter(&stored);

    let mut outline = outline_of(&store, &m.id);
    for entry in &mut outline {
        if entry.id == chapter.id {
            entry.title = "Chapter One".into();
        }
    }
    store.save_outline(&m.id, &outline).unwrap();
    set_paragraphs(
        &store,
        &chapter.doc_id,
        &[
            "Alpha one stays.",
            "Alpha two was here.",
            "Alpha three stays.",
        ],
    );
    let older = svc
        .commit_now(&store, &m.id, "Saved", "Author", "author@swarmdraft.local")
        .unwrap()
        .expect("older save");

    rewrite_paragraph(&store, &chapter.doc_id, 1, "Alpha two is new now.");
    append_paragraph(&store, &chapter.doc_id, "Alpha four added.");
    let mut outline = outline_of(&store, &m.id);
    let second_id = "chapter-two";
    let second_doc = section_doc_id(&m.id, second_id);
    outline.push(OutlineEntry {
        id: second_id.into(),
        parent_id: None,
        kind: "chapter".into(),
        title: "Chapter Two".into(),
        doc_id: second_doc.clone(),
    });
    store.save_outline(&m.id, &outline).unwrap();
    set_paragraphs(
        &store,
        &second_doc,
        &[
            "Beta one stays.",
            "Beta two was written.",
            "Beta three stays.",
        ],
    );
    svc.commit_now(&store, &m.id, "Saved", "Author", "author@swarmdraft.local")
        .unwrap();

    let cmp = svc.history_compare(&store, &m.id, &older, true).unwrap();
    assert_eq!(cmp.total_words_then, 10, "then counts visible words");
    assert_eq!(cmp.total_words_now, 24, "now matches the visible book");
    assert_eq!(cmp.sections.len(), 2, "sections: {:?}", cmp.sections);

    let mut saw_break = false;
    for section in &cmp.sections {
        let segments = section.segments.as_ref().expect("segments");
        let body: String = segments.iter().map(|seg| seg.text.as_str()).collect();
        assert!(
            body.contains('\n'),
            "{} ran paragraphs together: {body}",
            section.title
        );
        saw_break = true;
        for seg in segments {
            assert!(
                !seg.text.contains("<!--block") && !seg.text.contains("<!-- block"),
                "marker in {}: {}",
                section.title,
                seg.text
            );
        }
    }
    assert!(saw_break);

    let one = cmp
        .sections
        .iter()
        .find(|s| s.title == "Chapter One")
        .expect("chapter one");
    let two = cmp
        .sections
        .iter()
        .find(|s| s.title == "Chapter Two")
        .expect("chapter two");
    let one_body: String = one
        .segments
        .as_ref()
        .unwrap()
        .iter()
        .map(|seg| seg.text.as_str())
        .collect();
    let two_body: String = two
        .segments
        .as_ref()
        .unwrap()
        .iter()
        .map(|seg| seg.text.as_str())
        .collect();
    assert!(one_body.contains("Alpha one stays."), "{one_body}");
    assert!(one_body.contains("Alpha four added."), "{one_body}");
    assert!(!one_body.contains("Beta"), "{one_body}");
    assert!(
        !one_body.contains("stays. Alpha"),
        "paragraphs glued: {one_body}"
    );
    let removed: String = one
        .segments
        .as_ref()
        .unwrap()
        .iter()
        .filter(|seg| seg.segment_kind == "remove")
        .map(|seg| seg.text.as_str())
        .collect();
    let added: String = one
        .segments
        .as_ref()
        .unwrap()
        .iter()
        .filter(|seg| seg.segment_kind == "add")
        .map(|seg| seg.text.as_str())
        .collect();
    assert!(removed.contains("was"), "{removed}");
    assert!(!removed.contains("Alpha one"), "{removed}");
    assert!(added.contains("new"), "{added}");
    assert!(added.contains("Alpha four"), "{added}");
    assert!(two_body.contains("Beta one stays."), "{two_body}");
    assert!(two_body.contains("Beta three stays."), "{two_body}");
    assert!(!two_body.contains("Alpha"), "{two_body}");
    assert!(two.added >= 10 && two.removed == 0, "{:?}", two);
}

#[test]
fn compare_marks_added_and_removed_paragraphs_with_hard_breaks() {
    let (_dir, store) = temp_store();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
    let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.1".into());
    link_draft(&store, &m.id, "history-compare-hard-break.draft");
    let chapter = chapter(&stored);

    let broken = |top: &str, bottom: &str| {
        json!({
            "type": "paragraph",
            "content": [
                { "type": "text", "text": top },
                { "type": "hard_break" },
                { "type": "text", "text": bottom }
            ]
        })
    };
    set_doc_json(
        &store,
        &chapter.doc_id,
        json!([broken("Old top", "old bottom")]),
    );
    let older = svc
        .commit_now(&store, &m.id, "Saved", "Author", "author@swarmdraft.local")
        .unwrap()
        .expect("older save");
    set_doc_json(
        &store,
        &chapter.doc_id,
        json!([broken("New top", "new bottom")]),
    );
    svc.commit_now(&store, &m.id, "Saved", "Author", "author@swarmdraft.local")
        .unwrap();

    let cmp = svc.history_compare(&store, &m.id, &older, true).unwrap();
    let section = cmp
        .sections
        .iter()
        .find(|s| {
            s.segments
                .as_ref()
                .is_some_and(|segs| segs.iter().any(|seg| seg.text.contains("New top")))
        })
        .expect("chapter with the new paragraph");
    let segments = section.segments.as_ref().expect("segments");
    let removed = segments
        .iter()
        .find(|seg| seg.segment_kind == "remove")
        .expect("removed paragraph");
    let added = segments
        .iter()
        .find(|seg| seg.segment_kind == "add")
        .expect("added paragraph");
    assert!(
        removed.text.contains('\n'),
        "removed hard break became a plain gap: {}",
        removed.text
    );
    assert!(
        removed.text.contains("Old top") && removed.text.contains("old bottom"),
        "{}",
        removed.text
    );
    assert!(
        added.text.contains('\n'),
        "added hard break became a plain gap: {}",
        added.text
    );
    assert!(
        added.text.contains("New top") && added.text.contains("new bottom"),
        "{}",
        added.text
    );
    assert!(!removed.text.contains("<!--"), "{}", removed.text);
    assert!(!added.text.contains("<!--"), "{}", added.text);
}
