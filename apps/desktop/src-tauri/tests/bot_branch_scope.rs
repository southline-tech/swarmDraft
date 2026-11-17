//! A bot branch merges once the suggestions it made are decided, whatever else the
//! cache snapshot copied onto it, and a decided suggestion stays decided across a
//! relaunch and reopen, even from a file an older build wrote.

use serde_json::{json, Value};
use swarmdraft_lib::content::{self, FRAGMENT};
use swarmdraft_lib::draft::{BotRetention, DraftRepo, DraftService};
use swarmdraft_lib::manuscripts::{doc_update_since, state_vector, Author, Suggestion};
use swarmdraft_lib::storage::Store;
use yrs::{ReadTxn, StateVector, Transact, XmlFragment};

const BOT_ID: &str = "0b617f531be2948123f525a099ce21a3";
const BOT_NAME: &str = "QA Line Editor";

struct Book {
    dir: tempfile::TempDir,
    store: Store,
    svc: DraftService,
    manuscript_id: String,
    section_id: String,
    doc_id: String,
}

fn blank_book() -> Book {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().to_path_buf();
    let store = Store::open(&data).unwrap();
    let m = store
        .create_blank_manuscript_with_progress(None)
        .unwrap()
        .manuscript;
    let section = store
        .list_sections(&m.id)
        .unwrap()
        .into_iter()
        .find(|s| s.kind == "chapter")
        .unwrap();
    let svc = DraftService::new(data.clone(), "0.2.1".into());
    store
        .set_draft_file_path(
            &m.id,
            &data
                .join("drafts")
                .join("test manuscript.draft")
                .to_string_lossy(),
        )
        .unwrap();
    let book = Book {
        dir,
        store,
        svc,
        manuscript_id: m.id,
        section_id: section.id,
        doc_id: section.doc_id,
    };
    rewrite_chapter(
        &book,
        &json!([{"type":"paragraph","content":[{"type":"text","text":"one two three"}]}]),
    );
    book.svc
        .save_linked_or_needs_as(&book.store, &book.manuscript_id, "Saved")
        .unwrap();
    book
}

fn chapter_json(book: &Book) -> Vec<Value> {
    let doc = book.store.load_doc(&book.doc_id).unwrap();
    content::decode(&doc).into_iter().map(|b| b.node).collect()
}

/// Replace the chapter with `blocks` as one incremental update, as the editor does.
fn rewrite_chapter(book: &Book, blocks: &Value) {
    let doc = book.store.load_doc(&book.doc_id).unwrap();
    let since = state_vector(&doc);
    {
        let frag = doc.get_or_insert_xml_fragment(FRAGMENT);
        let mut txn = doc.transact_mut();
        let len = frag.len(&txn);
        frag.remove_range(&mut txn, 0, len);
    }
    content::encode(&doc, &json!({"type":"doc","content":blocks})).unwrap();
    let update = doc_update_since(&doc, &since);
    book.store.append_doc_update(&book.doc_id, &update).unwrap();
}

/// The bot replaces one word per id, in one write, then the suggestion commit runs.
fn bot_suggests(book: &Book, ids: &[&str]) {
    let author = format!("agent:{BOT_ID}");
    let mut blocks = chapter_json(book);
    let mut runs = Vec::new();
    for id in ids {
        runs.push(json!({"type":"text","text":format!("old-{id}"),"marks":[{"type":"suggestion_delete","attrs":{"id":id,"author":author,"ts":"t"}}]}));
        runs.push(json!({"type":"text","text":format!("new-{id}"),"marks":[{"type":"suggestion_insert","attrs":{"id":id,"author":author,"ts":"t"}}]}));
        runs.push(json!({"type":"text","text":" "}));
    }
    blocks.push(json!({"type":"paragraph","content":runs}));
    let doc = book.store.load_doc(&book.doc_id).unwrap();
    let since = state_vector(&doc);
    {
        let frag = doc.get_or_insert_xml_fragment(FRAGMENT);
        let mut txn = doc.transact_mut();
        let len = frag.len(&txn);
        frag.remove_range(&mut txn, 0, len);
    }
    content::encode(&doc, &json!({"type":"doc","content":blocks})).unwrap();
    let update = doc_update_since(&doc, &since);
    book.svc
        .record_bot_write(
            &book.store,
            &book.manuscript_id,
            BotRetention {
                comment: None,
                doc_id: Some(book.doc_id.clone()),
                doc_update: Some(update.clone()),
            },
            || -> Result<(), String> {
                book.store
                    .append_doc_update(&book.doc_id, &update)
                    .map_err(|e| e.to_string())?;
                for id in ids {
                    insert_row(book, id);
                }
                Ok(())
            },
        )
        .unwrap();
    book.svc
        .commit_bot_suggestion(
            &book.store,
            &book.manuscript_id,
            BOT_ID,
            BOT_NAME,
            "Bot suggestions",
        )
        .unwrap();
}

fn insert_row(book: &Book, id: &str) {
    book.store
        .insert_suggestion(
            &book.manuscript_id,
            &Suggestion {
                id: id.into(),
                section_id: book.section_id.clone(),
                block_id: None,
                kind: "replace".into(),
                quote: Some("old".into()),
                replacement: Some("new".into()),
                rationale: None,
                author: Author {
                    kind: "agent".into(),
                    id: BOT_ID.into(),
                    name: BOT_NAME.into(),
                },
                status: "open".into(),
                created_at: "2026-11-17T05:03:05.000Z".into(),
            },
        )
        .unwrap();
}

/// The editor's accept or reject: the marks of `id` go, then one decision call.
fn editor_decides(book: &Book, id: &str, accepted: bool) {
    let mut blocks = Value::Array(chapter_json(book));
    resolve_marks(&mut blocks, id, accepted);
    rewrite_chapter(book, &blocks);
    decide(book, id, accepted);
}

fn decide(book: &Book, id: &str, accepted: bool) {
    book.svc
        .commit_review_decision(
            &book.store,
            &book.manuscript_id,
            accepted,
            BOT_NAME,
            "CHAPTER ONE",
            "Author",
            Some(BOT_ID),
            Some(id),
            Some("suggestion_insert"),
            Some(&book.section_id),
        )
        .unwrap();
}

fn resolve_marks(node: &mut Value, id: &str, accepted: bool) {
    let children = if node.is_array() {
        node.as_array_mut()
    } else {
        node.get_mut("content").and_then(Value::as_array_mut)
    };
    let Some(children) = children else {
        return;
    };
    children.retain_mut(|child| {
        let Some(marks) = child.get_mut("marks").and_then(Value::as_array_mut) else {
            resolve_marks(child, id, accepted);
            return true;
        };
        let mut keep = true;
        marks.retain(|mark| {
            if mark["attrs"]["id"] != id {
                return true;
            }
            match (mark["type"].as_str(), accepted) {
                (Some("suggestion_insert"), false) | (Some("suggestion_delete"), true) => {
                    keep = false
                }
                _ => {}
            }
            false
        });
        if marks.is_empty() {
            child.as_object_mut().unwrap().remove("marks");
        }
        keep
    });
}

fn repo(book: &Book) -> DraftRepo {
    DraftRepo::open_working(&book.svc.worktree_path(&book.manuscript_id)).unwrap()
}

fn bot_branches(book: &Book) -> Vec<(String, String)> {
    repo(book)
        .search_ref_tips()
        .unwrap()
        .into_iter()
        .filter(|t| t.name.starts_with("bot/"))
        .map(|t| (t.name, t.oid))
        .collect()
}

fn unmerged_bot_branches(book: &Book) -> Vec<String> {
    let r = repo(book);
    let main = r.main_oid().unwrap().unwrap();
    bot_branches(book)
        .into_iter()
        .filter(|(_, oid)| r.merge_base(oid, &main).unwrap().as_deref() != Some(oid.as_str()))
        .map(|(name, _)| name)
        .collect()
}

fn merges(book: &Book) -> Vec<String> {
    let r = repo(book);
    let main = r.main_oid().unwrap().unwrap();
    r.walk_first_parent(&main)
        .unwrap()
        .into_iter()
        .map(|c| c.message)
        .filter(|m| m.starts_with("Merged bot/"))
        .collect()
}

fn status(book: &Book, id: &str) -> String {
    book.store.get_suggestion(id).unwrap().unwrap().status
}

fn live_mark_ids(book: &Book, ids: &[&str]) -> Vec<String> {
    let text: String = chapter_json(book).iter().map(Value::to_string).collect();
    ids.iter()
        .filter(|id| text.contains(&format!("\"{id}\"")))
        .map(|id| id.to_string())
        .collect()
}

fn save_and_pack(book: &Book) -> String {
    book.svc
        .save_linked_or_needs_as(&book.store, &book.manuscript_id, "Saved")
        .unwrap();
    book.svc
        .pack_if_linked(&book.store, &book.manuscript_id)
        .unwrap();
    book.store
        .draft_file_path(&book.manuscript_id)
        .unwrap()
        .unwrap()
}

/// Quit and start the app again (a new service, same data folder), then open the file.
/// Commit times are in seconds, and a relaunch takes longer than one.
fn relaunch_and_open(book: &mut Book, path: &str) {
    std::thread::sleep(std::time::Duration::from_millis(1100));
    book.svc = DraftService::new(book.dir.path().to_path_buf(), "0.2.1".into());
    let opened = book
        .svc
        .open_draft_path(&book.store, path, false)
        .unwrap()
        .unwrap();
    assert!(opened.recovery.is_none());
}

#[test]
fn branch_merges_when_its_own_suggestions_are_decided() {
    let mut book = blank_book();
    // Session one: the bot leaves a suggestion nobody decides.
    bot_suggests(&book, &["s-older"]);
    let path = save_and_pack(&book);
    relaunch_and_open(&mut book, &path);
    // A stale open row of the same bot, with no mark anywhere.
    insert_row(&book, "s-stale");
    // Session two: the same bot suggests again, on a new branch.
    bot_suggests(&book, &["s-new-a", "s-new-b"]);
    let open_before = unmerged_bot_branches(&book);
    assert_eq!(open_before.len(), 2, "{open_before:?}");

    editor_decides(&book, "s-new-a", true);
    assert!(merges(&book).is_empty(), "merged with s-new-b still open");
    editor_decides(&book, "s-new-b", false);

    let merged = merges(&book);
    assert_eq!(merged.len(), 1, "{merged:?}");
    let left = unmerged_bot_branches(&book);
    assert_eq!(left.len(), 1, "{left:?}");
    assert!(
        !merged[0].contains(&left[0]),
        "merged the older branch instead: {merged:?}"
    );
    assert_eq!(status(&book, "s-older"), "open");
    assert_eq!(status(&book, "s-new-a"), "accepted");
    assert_eq!(status(&book, "s-new-b"), "rejected");
    assert_eq!(
        live_mark_ids(&book, &["s-older"]),
        vec!["s-older".to_string()]
    );

    // Deciding the older branch's last suggestion later merges that branch too.
    editor_decides(&book, "s-older", true);
    assert!(unmerged_bot_branches(&book).is_empty());
    assert_eq!(status(&book, "s-older"), "accepted");
    let path = save_and_pack(&book);
    relaunch_and_open(&mut book, &path);
    assert_eq!(status(&book, "s-older"), "accepted");
    assert_eq!(status(&book, "s-new-a"), "accepted");
    let text: String = chapter_json(&book).iter().map(Value::to_string).collect();
    assert!(text.contains("new-s-older") && !text.contains("old-s-older"));
    assert!(text.contains("new-s-new-a") && text.contains("old-s-new-b"));
    assert!(live_mark_ids(&book, &["s-older", "s-new-a", "s-new-b"]).is_empty());
}

#[test]
fn decided_statuses_survive_relaunch_and_reopen() {
    let mut book = blank_book();
    bot_suggests(&book, &["s-older"]);
    let path = save_and_pack(&book);
    relaunch_and_open(&mut book, &path);
    bot_suggests(&book, &["s-a", "s-b"]);
    editor_decides(&book, "s-a", true);
    editor_decides(&book, "s-b", false);

    let path = save_and_pack(&book);
    relaunch_and_open(&mut book, &path);
    assert_eq!(status(&book, "s-a"), "accepted");
    assert_eq!(status(&book, "s-b"), "rejected");
    assert_eq!(status(&book, "s-older"), "open");
    assert_eq!(
        live_mark_ids(&book, &["s-a", "s-b", "s-older"]),
        vec!["s-older".to_string()]
    );
    let text: String = chapter_json(&book).iter().map(Value::to_string).collect();
    assert!(text.contains("new-s-a") && !text.contains("old-s-a"));
    assert!(text.contains("old-s-b") && !text.contains("new-s-b"));

    // A second relaunch changes nothing.
    let path = save_and_pack(&book);
    relaunch_and_open(&mut book, &path);
    assert_eq!(status(&book, "s-a"), "accepted");
    assert_eq!(status(&book, "s-b"), "rejected");
    assert_eq!(
        live_mark_ids(&book, &["s-a", "s-b", "s-older"]),
        vec!["s-older".to_string()]
    );
}

/// What an older build left: main's chapter still has the marks of decided
/// suggestions, and the cache reopened their rows.
#[test]
fn reopen_heals_a_file_whose_main_kept_decided_marks() {
    let mut book = blank_book();
    bot_suggests(&book, &["s-a", "s-b"]);
    let marked = book
        .store
        .load_doc(&book.doc_id)
        .unwrap()
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    editor_decides(&book, "s-a", true);
    editor_decides(&book, "s-b", false);
    assert_eq!(merges(&book).len(), 1);

    let r = repo(&book);
    let main = r.head_name().unwrap().unwrap();
    let main = main
        .strip_prefix("refs/heads/")
        .unwrap_or(&main)
        .to_string();
    let path_in_repo = format!("yjs/{}.bin", book.section_id);
    r.commit_files_on_branch(
        &main,
        "Edited chapter",
        "Author",
        "author@swarmdraft.local",
        &[(path_in_repo.as_str(), Some(marked.as_slice()))],
        false,
    )
    .unwrap();
    book.store
        .save_section_review_decisions(&book.manuscript_id, &book.section_id, &[])
        .unwrap();
    assert_eq!(status(&book, "s-a"), "open");
    book.svc
        .pack_if_linked(&book.store, &book.manuscript_id)
        .unwrap();
    let path = book
        .store
        .draft_file_path(&book.manuscript_id)
        .unwrap()
        .unwrap();

    relaunch_and_open(&mut book, &path);
    assert!(live_mark_ids(&book, &["s-a", "s-b"]).is_empty());
    assert_eq!(status(&book, "s-a"), "accepted");
    assert_eq!(status(&book, "s-b"), "rejected");
    let text: String = chapter_json(&book).iter().map(Value::to_string).collect();
    assert!(text.contains("new-s-a") && !text.contains("old-s-a"));
    assert!(text.contains("old-s-b") && !text.contains("new-s-b"));
}

/// An older build decided every suggestion on the branch but never merged it.
#[test]
fn a_settled_branch_left_unmerged_merges_on_open() {
    let mut book = blank_book();
    bot_suggests(&book, &["s-older"]);
    let path = save_and_pack(&book);
    relaunch_and_open(&mut book, &path);
    bot_suggests(&book, &["s-a"]);
    let branch = unmerged_bot_branches(&book)
        .into_iter()
        .find(|name| {
            let r = repo(&book);
            let tip = r.branch_target(name).unwrap().unwrap();
            String::from_utf8(r.file_bytes(&tip, "review/changes.json").unwrap().unwrap())
                .unwrap()
                .contains("s-a")
        })
        .unwrap();
    // The decision commit an older build made: only the index on the branch changes.
    let r = repo(&book);
    let tip = r.branch_target(&branch).unwrap().unwrap();
    let bytes = r.file_bytes(&tip, "review/changes.json").unwrap().unwrap();
    let mut index: Value = serde_json::from_slice(&bytes).unwrap();
    let rows = if index.is_array() {
        index.as_array_mut()
    } else {
        index.get_mut("changes").and_then(Value::as_array_mut)
    }
    .unwrap();
    for row in rows.iter_mut() {
        if row["id"] == "s-a" {
            row["status"] = json!("accepted");
            row["decidedAt"] = json!("2026-11-17T05:20:00.000Z");
            row["decidedBy"] = json!("Author");
        }
    }
    let out = serde_json::to_vec_pretty(&index).unwrap();
    r.commit_files_on_branch(
        &branch,
        "Accepted QA Line Editor's change",
        BOT_NAME,
        "bot@swarmdraft.local",
        &[("review/changes.json", Some(out.as_slice()))],
        false,
    )
    .unwrap();
    let mut blocks = Value::Array(chapter_json(&book));
    resolve_marks(&mut blocks, "s-a", true);
    rewrite_chapter(&book, &blocks);
    assert!(merges(&book).is_empty());
    let path = save_and_pack(&book);

    relaunch_and_open(&mut book, &path);
    let merged = merges(&book);
    assert_eq!(merged.len(), 1, "{merged:?}");
    assert!(
        merged[0].starts_with(&format!("Merged {branch}")),
        "{merged:?}"
    );
    assert_eq!(unmerged_bot_branches(&book).len(), 1);
    assert_eq!(status(&book, "s-a"), "accepted");
    assert_eq!(status(&book, "s-older"), "open");
}
