//! #345: each accept or reject is a commit on the bot's own `bot/*` branch, that
//! branch merges into main only after every suggestion on it is decided, and the
//! suggestion index (what `list_suggestions` reads) follows each decision.

use serde_json::json;
use swarmdraft_lib::content;
use swarmdraft_lib::draft::{BotRetention, DraftRepo, DraftService};
use swarmdraft_lib::manuscripts::{doc_update_since, state_vector, Author, Suggestion};
use swarmdraft_lib::storage::Store;
use yrs::{ReadTxn, StateVector, Transact};

const BOT_ID: &str = "0b617f531be2948123f525a099ce21a3";
const BOT_NAME: &str = "QA Line Editor";
const IDS: [&str; 3] = ["s-accept", "s-reject", "s-open"];

struct Book {
    _dir: tempfile::TempDir,
    store: Store,
    svc: DraftService,
    manuscript_id: String,
    section_id: String,
}

fn book_with_three_bot_suggestions() -> Book {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().to_path_buf();
    let store = Store::open(&data).unwrap();
    let stored = store.create_blank_manuscript_with_progress(None).unwrap();
    let m = stored.manuscript.clone();
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
    {
        let doc = content::new_doc();
        content::encode(
            &doc,
            &json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"one two three"}]}]}),
        )
        .unwrap();
        let state = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        store.replace_doc_state(&section.doc_id, &state).unwrap();
    }
    svc.save_linked_or_needs_as(&store, &m.id, "Saved").unwrap();

    // Three replacements, each an insert mark plus a delete mark with one id, as suggest_edit makes.
    let author = format!("agent:{BOT_ID}");
    let mut runs = Vec::new();
    for (i, id) in IDS.iter().enumerate() {
        runs.push(json!({"type":"text","text":format!("old{i}"),"marks":[{"type":"suggestion_delete","attrs":{"id":id,"author":author,"ts":"t"}}]}));
        runs.push(json!({"type":"text","text":format!("new{i}"),"marks":[{"type":"suggestion_insert","attrs":{"id":id,"author":author,"ts":"t"}}]}));
        runs.push(json!({"type":"text","text":" "}));
    }
    let doc = store.load_doc(&section.doc_id).unwrap();
    let since = state_vector(&doc);
    content::encode(
        &doc,
        &json!({"type":"doc","content":[{"type":"paragraph","content":runs}]}),
    )
    .unwrap();
    let update = doc_update_since(&doc, &since);
    svc.record_bot_write(
        &store,
        &m.id,
        BotRetention {
            comment: None,
            doc_id: Some(section.doc_id.clone()),
            doc_update: Some(update.clone()),
        },
        || -> Result<(), String> {
            store
                .append_doc_update(&section.doc_id, &update)
                .map_err(|e| e.to_string())?;
            for id in IDS {
                store
                    .insert_suggestion(
                        &m.id,
                        &Suggestion {
                            id: id.into(),
                            section_id: section.id.clone(),
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
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        },
    )
    .unwrap();
    svc.commit_bot_suggestion(&store, &m.id, BOT_ID, BOT_NAME, "Bot suggestions")
        .unwrap();
    Book {
        _dir: dir,
        store,
        svc,
        manuscript_id: m.id,
        section_id: section.id,
    }
}

/// What the editor sent on 9a26d5b: no agent id and the placeholder name "editor",
/// one call per mark kind.
fn decide_like_the_editor(book: &Book, id: &str, accepted: bool) {
    for kind in ["suggestion_delete", "suggestion_insert"] {
        book.svc
            .commit_review_decision(
                &book.store,
                &book.manuscript_id,
                accepted,
                "editor",
                "CHAPTER ONE",
                "Author",
                None,
                Some(id),
                Some(kind),
                Some(&book.section_id),
            )
            .unwrap();
    }
}

fn repo(book: &Book) -> DraftRepo {
    DraftRepo::open_working(&book.svc.worktree_path(&book.manuscript_id)).unwrap()
}

fn bot_branches(repo: &DraftRepo) -> Vec<String> {
    repo.search_ref_tips()
        .unwrap()
        .into_iter()
        .filter(|t| t.name.starts_with("bot/"))
        .map(|t| t.name)
        .collect()
}

fn main_messages(repo: &DraftRepo) -> Vec<String> {
    let main = repo.main_oid().unwrap().unwrap();
    repo.walk_first_parent(&main)
        .unwrap()
        .into_iter()
        .map(|c| c.message)
        .collect()
}

fn open_ids(book: &Book) -> Vec<String> {
    let mut ids: Vec<String> = book
        .store
        .suggestions_with_status(&book.section_id, "open")
        .unwrap()
        .into_iter()
        .map(|s| s.id)
        .collect();
    ids.sort();
    ids
}

fn status(book: &Book, id: &str) -> String {
    book.store.get_suggestion(id).unwrap().unwrap().status
}

#[test]
fn decisions_land_on_the_bots_branch_and_merge_after_the_last_one() {
    let book = book_with_three_bot_suggestions();
    let r = repo(&book);
    let branches = bot_branches(&r);
    assert_eq!(branches.len(), 1);
    let branch = branches[0].clone();
    assert!(branch.starts_with(&format!("bot/{BOT_ID}/")), "{branch}");

    decide_like_the_editor(&book, IDS[0], true);
    decide_like_the_editor(&book, IDS[1], false);

    let r = repo(&book);
    assert_eq!(
        bot_branches(&r),
        vec![branch.clone()],
        "a decision opened another bot branch"
    );
    let tip = r.branch_target(&branch).unwrap().unwrap();
    let on_branch: Vec<String> = r
        .walk_first_parent(&tip)
        .unwrap()
        .into_iter()
        .map(|c| c.message)
        .collect();
    assert!(
        on_branch
            .iter()
            .any(|m| m.starts_with(&format!("Accepted {BOT_NAME}'s change"))
                && m.contains(&format!("Change-Id: {}", IDS[0]))),
        "accept is not on the bot branch: {on_branch:?}"
    );
    assert!(
        on_branch
            .iter()
            .any(|m| m.starts_with(&format!("Rejected {BOT_NAME}'s change"))
                && m.contains(&format!("Change-Id: {}", IDS[1]))),
        "reject is not on the bot branch: {on_branch:?}"
    );
    assert!(
        on_branch.iter().all(|m| !m.contains("editor's")),
        "decision commit does not name the bot: {on_branch:?}"
    );
    assert_eq!(r.committer_name(&tip).unwrap(), BOT_NAME);
    assert!(
        main_messages(&r)
            .iter()
            .all(|m| !m.starts_with("Merged bot/")),
        "merged while a suggestion is still open"
    );

    // The suggestion index follows each decision.
    assert_eq!(status(&book, IDS[0]), "accepted");
    assert_eq!(status(&book, IDS[1]), "rejected");
    assert_eq!(open_ids(&book), vec![IDS[2].to_string()]);

    decide_like_the_editor(&book, IDS[2], true);
    let r = repo(&book);
    assert_eq!(bot_branches(&r), vec![branch.clone()]);
    let merges: Vec<String> = main_messages(&r)
        .into_iter()
        .filter(|m| m.starts_with("Merged bot/"))
        .collect();
    assert_eq!(
        merges.len(),
        1,
        "one merge after the last decision: {merges:?}"
    );
    assert!(
        merges[0].starts_with(&format!("Merged {branch}")),
        "{merges:?}"
    );
    assert_eq!(status(&book, IDS[2]), "accepted");
    assert!(open_ids(&book).is_empty());
}
