//! Bidirectional sync between SQLite / Yjs and the on-disk git working tree.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::json;
use yrs::types::text::YChange;
use yrs::types::xml::{XmlFragment, XmlOut};
use yrs::types::Attrs;
use yrs::{
    Any, Array, Doc, GetString, Map, MapPrelim, Out, ReadTxn, StateVector, Text, Transact,
    TransactionMut, XmlElementPrelim, XmlTextPrelim,
};

use crate::agent_access::{ACCESS_MODE_ALL, ACCESS_MODE_SELECTED};
use crate::content::{self, decode};
use crate::manuscripts::{
    Comment, CommentTombstone, OutlineEntry, ReviewDecisionRecord, DEFAULT_NUMBERING_STYLE,
    SECTION_KINDS,
};
use crate::notes;
use crate::storage::{StorageError, Store};

use super::changes::{self, map_kind};
use super::repo::{DraftRepo, DraftRepoError};
use super::sessions::safe_file_id;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookFile {
    title: String,
    #[serde(default)]
    numbering_style: Option<String>,
    #[serde(default)]
    book_author: Option<String>,
    chapters: Vec<BookSection>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookSection {
    id: String,
    doc_id: String,
    kind: String,
    title: String,
    #[serde(default)]
    parent_id: Option<String>,
}

/// Load git HEAD (working tree) into SQLite so the editor matches portable `.draft` files.
pub fn sync_worktree_to_store(
    store: &Store,
    manuscript_id: &str,
    worktree: &Path,
) -> Result<(), DraftRepoError> {
    let book_path = worktree.join("book.json");
    if !book_path.is_file() {
        return Err(DraftRepoError::Invalid(
            "draft repo missing book.json".into(),
        ));
    }
    let book: BookFile = serde_json::from_slice(&fs::read(&book_path)?)?;
    let style = book
        .numbering_style
        .as_deref()
        .unwrap_or(DEFAULT_NUMBERING_STYLE);
    store
        .update_manuscript_metadata(
            manuscript_id,
            &book.title,
            style,
            book.book_author.as_deref(),
        )
        .map_err(storage_err)?;
    let outline: Vec<OutlineEntry> = book
        .chapters
        .into_iter()
        .map(|s| {
            if !SECTION_KINDS.contains(&s.kind.as_str()) {
                return Err(DraftRepoError::Invalid(format!(
                    "unknown section kind: {}",
                    s.kind
                )));
            }
            Ok(OutlineEntry {
                id: s.id,
                parent_id: s.parent_id,
                kind: s.kind,
                title: s.title,
                doc_id: s.doc_id,
            })
        })
        .collect::<Result<_, _>>()?;
    store
        .save_outline(manuscript_id, &outline)
        .map_err(storage_err)?;
    let repo = DraftRepo::open_working(worktree).ok();
    let open_ids = repo
        .as_ref()
        .and_then(|repo| open_suggestion_ids(repo).ok())
        .unwrap_or_default();
    for section in store.list_sections(manuscript_id).map_err(storage_err)? {
        if section.kind != "chapter" {
            continue;
        }
        let yjs_path = worktree.join("yjs").join(format!("{}.bin", section.id));
        if !yjs_path.is_file() {
            continue;
        }
        let mut state = fs::read(&yjs_path)?;
        if let Some(repo) = &repo {
            if let Some(merged) = restore_open_suggestions(repo, &section.id, &state, &open_ids) {
                state = merged;
            }
        }
        store
            .replace_doc_state(&section.doc_id, &state)
            .map_err(storage_err)?;
    }
    import_notes_from_worktree(store, manuscript_id, worktree)?;
    import_comments_from_worktree(store, manuscript_id, worktree)?;
    import_decisions_from_worktree(store, manuscript_id, worktree)?;
    Ok(())
}

/// Rows a `main` checkpoint must not publish.
/// Open bot suggestions stay on `bot/*` until that branch merges.
#[derive(Default)]
pub(crate) struct SyncOmit {
    pub comment_ids: HashSet<String>,
    /// Exact `doc_updates` bytes still waiting for a `bot/*` commit, keyed by doc id.
    pub doc_updates: HashMap<String, Vec<Vec<u8>>>,
    /// Suggestion ids that stay out of `review/changes.json` on `main`.
    pub change_ids: HashSet<String>,
    /// Status of each withheld id (`open`, `accepted`, or `rejected`).
    /// Used to drop pending and rejected insert text from the chapter on `main`
    /// while keeping accepted text.
    pub change_status: HashMap<String, String>,
}

pub fn sync_store_to_worktree(
    store: &Store,
    manuscript_id: &str,
    worktree: &Path,
    omit: &SyncOmit,
) -> Result<HashMap<String, HashSet<String>>, DraftRepoError> {
    let manuscript = store.get_manuscript(manuscript_id).map_err(storage_err)?;
    let sections = store.list_sections(manuscript_id).map_err(storage_err)?;
    fs::create_dir_all(worktree.join("chapters"))?;
    fs::create_dir_all(worktree.join("yjs"))?;
    fs::create_dir_all(worktree.join("notes"))?;

    let chapter_order: Vec<serde_json::Value> = sections
        .iter()
        .map(|s| {
            json!({
                "id": s.id,
                "docId": s.doc_id,
                "kind": s.kind,
                "title": s.title,
                "parentId": s.parent_id,
                "position": s.position,
            })
        })
        .collect();

    let grants = agent_grants_json(store, manuscript_id)?;
    let book = json!({
        "title": manuscript.title,
        "numberingStyle": manuscript.numbering_style,
        "bookAuthor": manuscript.book_author,
        "chapters": chapter_order,
        "botAccess": grants,
    });
    fs::write(
        worktree.join("book.json"),
        serde_json::to_vec_pretty(&book).map_err(|e| DraftRepoError::Invalid(e.to_string()))?,
    )?;

    let mut pending_change_ids = omit.change_ids.clone();
    let mut discovered: HashMap<String, HashSet<String>> = HashMap::new();
    for section in &sections {
        if section.kind != "chapter" {
            continue;
        }
        let (loaded, ids) =
            chapter_doc_for_sync(store, &section.doc_id, omit, &mut pending_change_ids)?;
        if !ids.is_empty() {
            discovered.insert(section.doc_id.clone(), ids);
        }
        let doc = strip_withheld_marks(&loaded, &omit.change_status).unwrap_or(loaded);
        let state = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let file_key = &section.id;
        fs::write(worktree.join("yjs").join(format!("{file_key}.bin")), state)?;
        let blocks = decode(&doc);
        let md = content::markdown(&blocks);
        fs::write(worktree.join("chapters").join(format!("{file_key}.md")), md)?;
    }

    sync_notes(store, manuscript_id, worktree)?;
    sync_comments(store, manuscript_id, worktree, &omit.comment_ids)?;
    // Bot suggestion rows stay off `main` until the branch merges, decided or not.
    changes::write_change_index(store, manuscript_id, worktree, &pending_change_ids)?;
    Ok(discovered)
}

/// Chapter snapshot for `main`. Returns a new doc only when a withheld mark was removed,
/// so an unchanged chapter keeps its bytes.
fn strip_withheld_marks(doc: &Doc, status: &HashMap<String, String>) -> Option<Doc> {
    if status.is_empty() {
        return None;
    }
    let blocks = decode(doc);
    if blocks.is_empty() {
        return None;
    }
    let mut changed = false;
    let mut content = Vec::with_capacity(blocks.len());
    for block in blocks {
        let mut node = block.node;
        if filter_withheld_node(&mut node, status) {
            changed = true;
            // A paragraph whose only words were a withheld insert would stay as a
            // blank block. The checkpoint drops that block.
            if is_empty_paragraph(&node) {
                continue;
            }
        }
        content.push(node);
    }
    if !changed {
        return None;
    }
    let pm = json!({"type": "doc", "content": content});
    let out = content::new_doc();
    content::encode(&out, &pm).ok()?;
    Some(out)
}

/// Drop pending and rejected inserts. Keep accepted text without the mark.
/// Returns whether `node` changed.
fn filter_withheld_node(node: &mut serde_json::Value, status: &HashMap<String, String>) -> bool {
    let Some(children) = node
        .get_mut("content")
        .and_then(|value| value.as_array_mut())
    else {
        return false;
    };
    let mut changed = false;
    let mut kept = Vec::with_capacity(children.len());
    for mut child in children.drain(..) {
        if child["type"] == "text" {
            match withheld_text(&child, status) {
                WithheldText::Drop => changed = true,
                WithheldText::Same => kept.push(child),
                WithheldText::Edited(next) => {
                    changed = true;
                    kept.push(next);
                }
            }
        } else if filter_withheld_node(&mut child, status) {
            changed = true;
            if !is_empty_paragraph(&child) {
                kept.push(child);
            }
        } else {
            kept.push(child);
        }
    }
    *children = kept;
    changed
}

enum WithheldText {
    Drop,
    Same,
    Edited(serde_json::Value),
}

fn withheld_text(node: &serde_json::Value, status: &HashMap<String, String>) -> WithheldText {
    let Some(marks) = node["marks"].as_array() else {
        return WithheldText::Same;
    };
    let mut drop_text = false;
    let mut next_marks = Vec::new();
    let mut edited = false;
    for mark in marks {
        let kind = mark["type"].as_str().unwrap_or("");
        let id = mark["attrs"]["id"].as_str().unwrap_or("");
        let Some(state) = status.get(id) else {
            next_marks.push(mark.clone());
            continue;
        };
        let accepted = state == "accepted";
        match kind {
            "suggestion_insert" if !accepted => drop_text = true,
            "suggestion_delete" if accepted => drop_text = true,
            "suggestion_insert" | "suggestion_delete" | "format_change" => edited = true,
            _ => next_marks.push(mark.clone()),
        }
    }
    if drop_text {
        return WithheldText::Drop;
    }
    if !edited {
        return WithheldText::Same;
    }
    let mut next = node.clone();
    if next_marks.is_empty() {
        next.as_object_mut().map(|object| object.remove("marks"));
    } else {
        next["marks"] = serde_json::Value::Array(next_marks);
    }
    WithheldText::Edited(next)
}

/// A paragraph or heading with no text and no inline atom left.
fn is_empty_paragraph(node: &serde_json::Value) -> bool {
    let ty = node["type"].as_str().unwrap_or("");
    if ty != "paragraph" && ty != "heading" {
        return false;
    }
    let Some(content) = node.get("content").and_then(|value| value.as_array()) else {
        return true;
    };
    !content.iter().any(|child| match child["type"].as_str() {
        Some("text") => !child["text"].as_str().unwrap_or("").is_empty(),
        Some("hard_break" | "image" | "footnote") => true,
        _ => !is_empty_paragraph(child),
    })
}

/// Suggestion ids still open on an unmerged `bot/*` tip.
/// An id accepted or rejected on `main` or on any bot tip is not open.
fn open_suggestion_ids(repo: &DraftRepo) -> Result<HashSet<String>, DraftRepoError> {
    let Some(main) = repo.head_oid()? else {
        return Ok(HashSet::new());
    };
    let mut decided = HashSet::new();
    let mut open = HashSet::new();
    for entry in changes::changes_in_commit(repo, &main)? {
        if entry.status == "accepted" || entry.status == "rejected" {
            decided.insert(entry.id);
        }
    }
    for tip in repo.search_ref_tips()? {
        if !tip.name.starts_with("bot/") {
            continue;
        }
        let Some(base) = repo.merge_base(&tip.oid, &main)? else {
            continue;
        };
        let unmerged = base != tip.oid;
        for entry in changes::changes_in_commit(repo, &tip.oid)? {
            if entry.status == "accepted" || entry.status == "rejected" {
                decided.insert(entry.id.clone());
                open.remove(&entry.id);
            } else if unmerged && entry.status == "open" {
                open.insert(entry.id);
            }
        }
    }
    open.retain(|id| !decided.contains(id));
    Ok(open)
}

/// Put suggestion text that is still open back into `main_bytes` from unmerged bot tips.
/// Text already on `main` stays, including a keystroke the bot snapshot does not have.
/// A rejected insert is not copied. Returns the new state only when a mark was added.
fn restore_open_suggestions(
    repo: &DraftRepo,
    section_id: &str,
    main_bytes: &[u8],
    open_ids: &HashSet<String>,
) -> Option<Vec<u8>> {
    if open_ids.is_empty() {
        return None;
    }
    let main = doc_from_update(main_bytes)?;
    let mut seen = changes::suggestion_ids(&main);
    seen.retain(|id| open_ids.contains(id));
    let mut changed = false;
    let main_oid = repo.head_oid().ok().flatten()?;
    let tips = repo.search_ref_tips().ok()?;
    let path = format!("yjs/{section_id}.bin");
    for tip in tips {
        if !tip.name.starts_with("bot/") {
            continue;
        }
        let Ok(Some(base)) = repo.merge_base(&tip.oid, &main_oid) else {
            continue;
        };
        if base == tip.oid {
            continue;
        }
        let Ok(Some(bytes)) = repo.file_bytes(&tip.oid, &path) else {
            continue;
        };
        let Some(bot) = doc_from_update(&bytes) else {
            eprintln!("draft open skipped a bot chapter that did not decode");
            continue;
        };
        if merge_open_suggestions(&main, &bot, open_ids, &mut seen) {
            changed = true;
        }
    }
    if !changed {
        return None;
    }
    let state = main
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    Some(state)
}

fn doc_from_update(bytes: &[u8]) -> Option<Doc> {
    use yrs::updates::decoder::Decode;
    use yrs::Update;
    let doc = content::new_doc();
    let update = Update::decode_v1(bytes).ok()?;
    if doc.transact_mut().apply_update(update).is_err() {
        return None;
    }
    Some(doc)
}

struct OpenRun {
    /// Utf-16 offset in the block's text that is not a suggestion insert.
    offset: u32,
    /// Order within the block. Same-offset runs stay in this order.
    seq: u32,
    text: String,
    marks: Vec<serde_json::Value>,
}

/// Insert open suggestion runs from `bot` into `main`. Ids already in `seen` are skipped.
fn merge_open_suggestions(
    main: &Doc,
    bot: &Doc,
    open_ids: &HashSet<String>,
    seen: &mut HashSet<String>,
) -> bool {
    let main_blocks = content::decode(main);
    let bot_blocks = content::decode(bot);
    let mut splices: Vec<(usize, OpenRun)> = Vec::new();
    let mut appends: Vec<Vec<OpenRun>> = Vec::new();
    let mut mi = 0usize;
    for block in &bot_blocks {
        let runs = open_runs(&block.node, open_ids, seen);
        let bot_plain = plain_text(&block.node);
        if let Some(rel) = main_blocks[mi..]
            .iter()
            .position(|candidate| blocks_match(&plain_text(&candidate.node), &bot_plain))
        {
            let idx = mi + rel;
            mi = idx + 1;
            for run in runs {
                if let Some(id) = suggestion_insert_id_in_marks(&run.marks) {
                    seen.insert(id);
                }
                splices.push((idx, run));
            }
        } else if !runs.is_empty() {
            for run in &runs {
                if let Some(id) = suggestion_insert_id_in_marks(&run.marks) {
                    seen.insert(id.to_string());
                }
            }
            appends.push(runs);
        }
    }
    if splices.is_empty() && appends.is_empty() {
        return false;
    }
    splices.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then(a.1.offset.cmp(&b.1.offset))
            .then(a.1.seq.cmp(&b.1.seq))
    });
    apply_open_runs(main, main_blocks.len(), &splices, &appends);
    true
}

fn apply_open_runs(
    doc: &Doc,
    block_count: usize,
    splices: &[(usize, OpenRun)],
    appends: &[Vec<OpenRun>],
) {
    let frag = doc.get_or_insert_xml_fragment(content::FRAGMENT);
    let mut txn = doc.transact_mut();
    let elements: Vec<_> = frag
        .children(&txn)
        .filter_map(|child| match child {
            XmlOut::Element(element) => Some(element),
            _ => None,
        })
        .collect();
    if elements.len() != block_count {
        eprintln!("draft open left a suggestion out; the chapter shape changed");
    }
    for (idx, run) in splices {
        let Some(element) = elements.get(*idx) else {
            continue;
        };
        if let Err(err) = insert_run(&mut txn, element, run) {
            eprintln!("draft open left a suggestion out: {err}");
        }
    }
    for runs in appends {
        let element = frag.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
        for run in runs {
            if let Err(err) = insert_run(&mut txn, &element, run) {
                eprintln!("draft open left a suggestion out: {err}");
            }
        }
    }
}

fn insert_run(
    txn: &mut TransactionMut,
    element: &yrs::XmlElementRef,
    run: &OpenRun,
) -> Result<(), String> {
    let attrs = marks_to_attrs(&run.marks)?;
    let texts: Vec<_> = element
        .children(txn)
        .filter_map(|child| match child {
            XmlOut::Text(text) => Some(text),
            _ => None,
        })
        .collect();
    let mut plain = 0u32;
    for text in &texts {
        let mut index = 0u32;
        for diff in text.diff(txn, YChange::identity) {
            let chunk = match &diff.insert {
                Out::Any(Any::String(value)) => value.to_string(),
                _ => continue,
            };
            let len = utf16_len(&chunk);
            let insert_mark = diff.attributes.as_ref().is_some_and(|attrs| {
                attrs
                    .keys()
                    .any(|key| key.as_ref().starts_with("suggestion_insert"))
            });
            if insert_mark {
                index += len;
                continue;
            }
            if plain == run.offset || (plain < run.offset && plain + len >= run.offset) {
                let at = index + run.offset.saturating_sub(plain);
                text.insert_with_attributes(txn, at, &run.text, attrs);
                return Ok(());
            }
            plain += len;
            index += len;
        }
    }
    if let Some(text) = texts.last() {
        let len = utf16_len(&text.get_string(txn));
        text.insert_with_attributes(txn, len, &run.text, attrs);
        return Ok(());
    }
    let text = element.push_back(txn, XmlTextPrelim::new(""));
    text.insert_with_attributes(txn, 0, &run.text, attrs);
    Ok(())
}

fn marks_to_attrs(marks: &[serde_json::Value]) -> Result<Attrs, String> {
    let keys = content::mark_keys(marks)?;
    let mut attrs = Attrs::new();
    for (mark, key) in marks.iter().zip(keys) {
        let value = mark.get("attrs").cloned().unwrap_or_else(|| json!({}));
        let any = serde_json::from_value(value).unwrap_or(Any::Null);
        attrs.insert(key.into(), any);
    }
    Ok(attrs)
}

fn open_runs(
    node: &serde_json::Value,
    open_ids: &HashSet<String>,
    seen: &HashSet<String>,
) -> Vec<OpenRun> {
    let mut runs = Vec::new();
    let mut plain = 0u32;
    for child in node["content"].as_array().into_iter().flatten() {
        if child["type"] != "text" {
            continue;
        }
        let text = child["text"].as_str().unwrap_or("");
        if let Some(id) = suggestion_insert_id(child) {
            if open_ids.contains(&id) && !seen.contains(&id) {
                let marks = child["marks"].as_array().cloned().unwrap_or_default();
                runs.push(OpenRun {
                    offset: plain,
                    seq: runs.len() as u32,
                    text: text.to_string(),
                    marks,
                });
            }
            continue;
        }
        plain += utf16_len(text);
    }
    runs
}

fn suggestion_insert_id(node: &serde_json::Value) -> Option<String> {
    let marks = node["marks"].as_array()?;
    suggestion_insert_id_in_marks(marks)
}

fn suggestion_insert_id_in_marks(marks: &[serde_json::Value]) -> Option<String> {
    marks.iter().find_map(|mark| {
        if mark["type"] != "suggestion_insert" {
            return None;
        }
        let id = mark["attrs"]["id"].as_str().unwrap_or("");
        if id.is_empty() {
            None
        } else {
            Some(id.to_string())
        }
    })
}

fn plain_text(node: &serde_json::Value) -> String {
    let mut out = String::new();
    for child in node["content"].as_array().into_iter().flatten() {
        if child["type"] == "text" && suggestion_insert_id(child).is_none() {
            out.push_str(child["text"].as_str().unwrap_or(""));
        }
    }
    out
}

/// The same paragraph. An empty bot paragraph is a suggestion block and is not a match.
/// `main` may be longer when a keystroke landed after the bot snapshot.
fn blocks_match(main_plain: &str, bot_plain: &str) -> bool {
    if bot_plain.is_empty() || main_plain.is_empty() {
        return false;
    }
    main_plain.starts_with(bot_plain) || bot_plain.starts_with(main_plain)
}

fn utf16_len(text: &str) -> u32 {
    text.encode_utf16().count() as u32
}

/// Chapter document to write. Pending bot updates are left out when the rest of the
/// chapter still integrates. A later keystroke that does not integrate without one is
/// kept by writing the whole chapter, and the suggestion ids that disappear from the
/// replay without those updates are still omitted from `review/changes.json`.
fn chapter_doc_for_sync(
    store: &Store,
    doc_id: &str,
    omit: &SyncOmit,
    pending_change_ids: &mut HashSet<String>,
) -> Result<(Doc, HashSet<String>), DraftRepoError> {
    let skips = omit
        .doc_updates
        .get(doc_id)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if skips.is_empty() {
        return Ok((store.load_doc(doc_id).map_err(storage_err)?, HashSet::new()));
    }
    let full = store.load_doc(doc_id).map_err(storage_err)?;
    let loaded = store.load_doc_except(doc_id, skips).map_err(storage_err)?;
    let mut found = HashSet::new();
    for id in
        changes::suggestion_ids(&full).difference(&changes::suggestion_ids(&loaded.without_skipped))
    {
        found.insert(id.clone());
        pending_change_ids.insert(id.clone());
    }
    Ok((loaded.doc, found))
}

pub(super) fn to_pretty(value: &impl Serialize) -> Result<Vec<u8>, DraftRepoError> {
    let mut bytes =
        serde_json::to_vec_pretty(value).map_err(|e| DraftRepoError::Invalid(e.to_string()))?;
    if !bytes.ends_with(b"\n") {
        bytes.push(b'\n');
    }
    Ok(bytes)
}

/// Write `bytes` only when the file contents differ, so an unchanged index does not look dirty.
pub(super) fn write_stable(path: &Path, bytes: &[u8]) -> Result<(), DraftRepoError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if path.is_file() && fs::read(path).ok().as_deref() == Some(bytes) {
        return Ok(());
    }
    fs::write(path, bytes)?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommentThreadFile {
    thread_id: String,
    rows: Vec<CommentRowFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommentRowFile {
    id: String,
    section_id: String,
    block_id: Option<String>,
    quote: Option<String>,
    body: String,
    thread_id: Option<String>,
    author_kind: String,
    author_id: String,
    author_name: String,
    created_at: String,
    resolved_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    deleted_at: Option<String>,
}

#[derive(Clone)]
pub(crate) struct GitComment {
    pub comment: Comment,
    pub deleted_at: Option<String>,
}

/// One comment thread file, rows sorted by `createdAt` then id.
pub(crate) fn encode_comment_thread(
    thread_id: &str,
    rows: &[GitComment],
) -> Result<Vec<u8>, DraftRepoError> {
    let mut rows = rows.to_vec();
    rows.sort_by(|a, b| {
        a.comment
            .created_at
            .cmp(&b.comment.created_at)
            .then(a.comment.id.cmp(&b.comment.id))
    });
    let payload = CommentThreadFile {
        thread_id: thread_id.to_string(),
        rows: rows.into_iter().map(CommentRowFile::from).collect(),
    };
    to_pretty(&payload)
}

fn sync_comments(
    store: &Store,
    manuscript_id: &str,
    worktree: &Path,
    pending_comment_ids: &HashSet<String>,
) -> Result<(), DraftRepoError> {
    let comments = store
        .comments_for_manuscript(manuscript_id)
        .map_err(storage_err)?;
    let tombstones = store
        .comment_tombstones(manuscript_id)
        .map_err(storage_err)?;
    let mut groups: BTreeMap<String, Vec<GitComment>> = BTreeMap::new();
    for comment in comments {
        if pending_comment_ids.contains(&comment.id) {
            continue;
        }
        push_thread_row(
            &mut groups,
            GitComment {
                comment,
                deleted_at: None,
            },
        );
    }
    for tomb in tombstones {
        let deleted_at = tomb.deleted_at.clone();
        push_thread_row(
            &mut groups,
            GitComment {
                comment: tomb.comment,
                deleted_at: Some(deleted_at),
            },
        );
    }
    let dir = worktree.join("comments");
    fs::create_dir_all(&dir)?;
    // Git does not store an empty directory. The placeholder keeps `comments/` in the tree.
    write_stable(&dir.join(".keep"), b"")?;
    let mut keep = HashSet::new();
    for (thread_id, rows) in groups {
        let mut by_id: BTreeMap<String, GitComment> = BTreeMap::new();
        for row in rows {
            let id = row.comment.id.clone();
            let tombstone_wins = by_id
                .get(&id)
                .map(|prev| prev.deleted_at.is_some())
                .unwrap_or(false);
            if !tombstone_wins {
                by_id.insert(id, row);
            }
        }
        let mut rows: Vec<GitComment> = by_id.into_values().collect();
        rows.sort_by(|a, b| {
            a.comment
                .created_at
                .cmp(&b.comment.created_at)
                .then(a.comment.id.cmp(&b.comment.id))
        });
        let file_name = format!("{thread_id}.json");
        keep.insert(file_name.clone());
        let payload = CommentThreadFile {
            thread_id: thread_id.clone(),
            rows: rows.into_iter().map(CommentRowFile::from).collect(),
        };
        write_stable(&dir.join(&file_name), &to_pretty(&payload)?)?;
    }
    // A delete keeps its file (the rows are tombstones). Drop only a thread file that
    // git no longer lists because the cache has neither a live row nor a tombstone.
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.ends_with(".json") && !keep.contains(name.as_ref()) {
            fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

fn push_thread_row(groups: &mut BTreeMap<String, Vec<GitComment>>, row: GitComment) {
    let key = row
        .comment
        .thread_id
        .clone()
        .filter(|id| safe_file_id(id))
        .unwrap_or_else(|| row.comment.id.clone());
    if !safe_file_id(&key) {
        return;
    }
    groups.entry(key).or_default().push(row);
}

fn import_comments_from_worktree(
    store: &Store,
    manuscript_id: &str,
    worktree: &Path,
) -> Result<(), DraftRepoError> {
    let mut live: BTreeMap<String, Comment> = BTreeMap::new();
    let mut tombs: BTreeMap<String, CommentTombstone> = BTreeMap::new();
    let dir = worktree.join("comments");
    if dir.is_dir() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let bytes = fs::read(&path)?;
            absorb_comment_bytes(&bytes, false, &mut live, &mut tombs);
        }
    }
    // In-flight bot comments are not on main yet. A tombstone already on main wins.
    if let Ok(repo) = DraftRepo::open_working(worktree) {
        if let Ok(tips) = repo.search_ref_tips() {
            for tip in tips {
                if !tip.name.starts_with("bot/") {
                    continue;
                }
                let Ok(paths) = repo.list_tree_files(&tip.oid, "comments/") else {
                    continue;
                };
                for path in paths {
                    if !path.ends_with(".json") {
                        continue;
                    }
                    let Ok(Some(bytes)) = repo.file_bytes(&tip.oid, &path) else {
                        continue;
                    };
                    absorb_comment_bytes(&bytes, true, &mut live, &mut tombs);
                }
            }
        }
    }
    let live_rows: Vec<Comment> = live.into_values().collect();
    let tomb_rows: Vec<CommentTombstone> = tombs.into_values().collect();
    store
        .reconcile_comments_from_git(manuscript_id, &live_rows, &tomb_rows)
        .map_err(storage_err)?;
    Ok(())
}

fn absorb_comment_bytes(
    bytes: &[u8],
    from_bot: bool,
    live: &mut BTreeMap<String, Comment>,
    tombs: &mut BTreeMap<String, CommentTombstone>,
) {
    let Ok(file) = serde_json::from_slice::<CommentThreadFile>(bytes) else {
        eprintln!("draft comment file skipped (unreadable)");
        return;
    };
    for row in file.rows {
        let deleted_at = row.deleted_at.clone();
        let Some(comment) = row.into_comment(&file.thread_id) else {
            continue;
        };
        let id = comment.id.clone();
        if let Some(deleted_at) = deleted_at {
            if from_bot && live.contains_key(&id) {
                continue;
            }
            live.remove(&id);
            tombs.insert(
                id,
                CommentTombstone {
                    comment,
                    deleted_at,
                },
            );
            continue;
        }
        if tombs.contains_key(&id) {
            continue;
        }
        if from_bot && live.contains_key(&id) {
            continue;
        }
        live.insert(id, comment);
    }
}

/// Comment row ids stored on one commit, including tombstones. Empty when the tree has none.
pub(crate) fn comment_rows_in_commit(
    repo: &DraftRepo,
    oid: &str,
) -> Result<Vec<GitComment>, DraftRepoError> {
    let mut out = Vec::new();
    for path in repo.list_tree_files(oid, "comments/")? {
        if !path.ends_with(".json") {
            continue;
        }
        let Some(bytes) = repo.file_bytes(oid, &path)? else {
            continue;
        };
        let Ok(file) = serde_json::from_slice::<CommentThreadFile>(&bytes) else {
            continue;
        };
        for row in file.rows {
            let deleted_at = row.deleted_at.clone();
            let Some(comment) = row.into_comment(&file.thread_id) else {
                continue;
            };
            out.push(GitComment {
                comment,
                deleted_at,
            });
        }
    }
    Ok(out)
}

fn import_decisions_from_worktree(
    store: &Store,
    manuscript_id: &str,
    worktree: &Path,
) -> Result<(), DraftRepoError> {
    // `main` after a merge, and any bot branch that is still open.
    let mut by_id: BTreeMap<String, (String, ReviewDecisionRecord)> = BTreeMap::new();
    let path = worktree.join("review").join("changes.json");
    if path.is_file() {
        absorb_decision_bytes(&fs::read(&path)?, false, &mut by_id);
    }
    if let Ok(repo) = DraftRepo::open_working(worktree) {
        if let Ok(tips) = repo.search_ref_tips() {
            for tip in tips {
                if !tip.name.starts_with("bot/") {
                    continue;
                }
                let Ok(Some(bytes)) = repo.file_bytes(&tip.oid, "review/changes.json") else {
                    continue;
                };
                absorb_decision_bytes(&bytes, true, &mut by_id);
            }
        }
    }
    let records: Vec<(String, ReviewDecisionRecord)> = by_id.into_values().collect();
    store
        .replace_manuscript_review_decisions(manuscript_id, &records)
        .map_err(storage_err)?;
    Ok(())
}

fn absorb_decision_bytes(
    bytes: &[u8],
    from_bot: bool,
    by_id: &mut BTreeMap<String, (String, ReviewDecisionRecord)>,
) {
    let entries = match changes::parse_change_index(bytes) {
        Ok(entries) => entries,
        Err(()) => {
            eprintln!("draft change index skipped (unreadable)");
            return;
        }
    };
    for entry in entries {
        if entry.status != "accepted" && entry.status != "rejected" {
            continue;
        }
        if entry.section_id.is_empty() || entry.id.is_empty() {
            continue;
        }
        if from_bot {
            if let Some((_, existing)) = by_id.get(&entry.id) {
                if existing.status == "accepted" || existing.status == "rejected" {
                    continue;
                }
            }
        }
        let decided_by = entry
            .decided_by
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "author".into());
        let decided_at = entry
            .decided_at
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".into());
        by_id.insert(
            entry.id.clone(),
            (
                entry.section_id.clone(),
                ReviewDecisionRecord {
                    kind: map_kind(&entry.kind).into(),
                    id: entry.id,
                    status: entry.status,
                    decided_at,
                    decided_by,
                },
            ),
        );
    }
}

impl From<GitComment> for CommentRowFile {
    fn from(row: GitComment) -> Self {
        let c = row.comment;
        Self {
            id: c.id,
            section_id: c.section_id,
            block_id: c.block_id,
            quote: c.quote,
            body: c.body,
            thread_id: c.thread_id,
            author_kind: c.author.kind,
            author_id: c.author.id,
            author_name: c.author.name,
            created_at: c.created_at,
            resolved_at: c.resolved_at,
            deleted_at: row.deleted_at,
        }
    }
}

impl CommentRowFile {
    fn into_comment(self, file_thread: &str) -> Option<Comment> {
        if self.id.is_empty() || self.body.is_empty() || self.created_at.is_empty() {
            return None;
        }
        if self.author_kind != "human" && self.author_kind != "agent" {
            return None;
        }
        let thread_id = self.thread_id.or_else(|| {
            if file_thread.is_empty() {
                None
            } else {
                Some(file_thread.to_string())
            }
        });
        Some(Comment {
            id: self.id,
            section_id: self.section_id,
            block_id: self.block_id,
            quote: self.quote,
            body: self.body,
            thread_id,
            author: crate::manuscripts::Author {
                kind: self.author_kind,
                id: self.author_id,
                name: self.author_name,
            },
            created_at: self.created_at,
            resolved_at: self.resolved_at,
        })
    }
}

fn sync_notes(store: &Store, manuscript_id: &str, worktree: &Path) -> Result<(), DraftRepoError> {
    let doc = store.load_notes_doc(manuscript_id).map_err(storage_err)?;
    for entry in notes::list_note_entries(&doc) {
        let body = note_body(&doc, &entry.id);
        let front = format!(
            "---\ntitle: {}\nsectionId: {}\nauthorKind: {}\nauthorId: {}\nauthorName: {}\n---\n\n",
            yaml_escape(&entry.title),
            entry.section_id.as_deref().unwrap_or(""),
            entry.author_kind,
            entry.author_id,
            yaml_escape(&entry.author_name),
        );
        fs::write(
            worktree.join("notes").join(format!("{}.md", entry.id)),
            format!("{front}{body}"),
        )?;
    }
    Ok(())
}

fn note_body(doc: &Doc, note_id: &str) -> String {
    let field = notes::body_field(note_id);
    let blocks = content::decode_named_fragment(doc, &field);
    content::markdown(&blocks)
}

fn yaml_escape(s: &str) -> String {
    if s.contains(':') || s.contains('"') || s.contains('\n') {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        s.to_string()
    }
}

fn agent_grants_json(
    store: &Store,
    manuscript_id: &str,
) -> Result<serde_json::Value, DraftRepoError> {
    let agents = store.list_agents().map_err(storage_err)?;
    let mut out = Vec::new();
    for agent in agents {
        let mode = store
            .agent_manuscript_access_mode(&agent.id)
            .unwrap_or_else(|_| ACCESS_MODE_SELECTED.into());
        let allowed = if mode == ACCESS_MODE_ALL {
            true
        } else {
            store
                .list_agent_manuscript_grants(&agent.id)
                .map(|g| g.contains(&manuscript_id.to_string()))
                .unwrap_or(false)
        };
        if allowed {
            out.push(json!({ "agentId": agent.id, "agentName": agent.name, "mode": mode }));
        }
    }
    Ok(json!(out))
}

fn import_notes_from_worktree(
    store: &Store,
    manuscript_id: &str,
    worktree: &Path,
) -> Result<(), DraftRepoError> {
    let notes_dir = worktree.join("notes");
    if !notes_dir.is_dir() {
        return Ok(());
    }
    let doc = content::new_doc();
    let order = doc.get_or_insert_array(notes::ORDER_KEY);
    let entries = doc.get_or_insert_map(notes::ENTRIES_KEY);
    let now = store.now().map_err(storage_err)?;
    let mut ids = Vec::new();
    for entry in fs::read_dir(&notes_dir)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or_else(|| DraftRepoError::Invalid("bad note file name".into()))?
            .to_string();
        let text = fs::read_to_string(&path)?;
        let (meta, body) = parse_note_frontmatter(&text)?;
        let title = meta.get("title").cloned().unwrap_or_default();
        let section_id = meta.get("sectionId").cloned().filter(|s| !s.is_empty());
        let author_kind = meta
            .get("authorKind")
            .map(|s| s.as_str())
            .unwrap_or("human");
        let author_kind = if author_kind == "agent" {
            "agent"
        } else {
            "human"
        };
        let author_id = meta.get("authorId").cloned().unwrap_or_default();
        let author_name = meta.get("authorName").cloned().unwrap_or_default();
        let body_name = notes::body_field(&id);
        doc.get_or_insert_xml_fragment(body_name.as_str());
        let body_pm = notes_body_to_pm(&body);
        content::encode_fragment(&doc, body_name.as_str(), &body_pm)
            .map_err(DraftRepoError::Invalid)?;
        {
            let mut txn = doc.transact_mut();
            entries.insert(
                &mut txn,
                id.as_str(),
                MapPrelim::from([
                    ("title", title.as_str()),
                    ("sectionId", section_id.as_deref().unwrap_or("")),
                    ("authorKind", author_kind),
                    ("authorId", author_id.as_str()),
                    ("authorName", author_name.as_str()),
                    ("createdAt", now.as_str()),
                    ("updatedAt", now.as_str()),
                ]),
            );
            order.push_back(&mut txn, id.as_str());
        }
        ids.push(id);
    }
    if ids.is_empty() {
        return Ok(());
    }
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    store
        .replace_doc_state(&notes::notes_doc_id(manuscript_id), &state)
        .map_err(storage_err)?;
    Ok(())
}

fn notes_body_to_pm(body: &str) -> serde_json::Value {
    let lines: Vec<&str> = if body.is_empty() {
        vec![""]
    } else {
        body.split('\n').collect()
    };
    let content: Vec<serde_json::Value> = lines
        .into_iter()
        .map(|line| {
            if line.is_empty() {
                json!({"type":"paragraph","content":[]})
            } else {
                json!({"type":"paragraph","content":[{"type":"text","text": line}]})
            }
        })
        .collect();
    json!({"type":"doc","content": content})
}

fn parse_note_frontmatter(text: &str) -> Result<(HashMap<String, String>, String), DraftRepoError> {
    let trimmed = text
        .strip_prefix("---\n")
        .ok_or_else(|| DraftRepoError::Invalid("note file missing frontmatter".into()))?;
    let (header, body) = trimmed
        .split_once("\n---\n")
        .ok_or_else(|| DraftRepoError::Invalid("note file missing frontmatter end".into()))?;
    let mut meta = HashMap::new();
    for line in header.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        meta.insert(key.trim().to_string(), yaml_unescape(value.trim()));
    }
    let body = body.strip_prefix('\n').unwrap_or(body);
    Ok((meta, body.to_string()))
}

fn yaml_unescape(value: &str) -> String {
    if value.starts_with('"') && value.ends_with('"') && value.len() >= 2 {
        value[1..value.len() - 1]
            .replace("\\\"", "\"")
            .replace("\\\\", "\\")
    } else {
        value.to_string()
    }
}

fn storage_err(e: StorageError) -> DraftRepoError {
    DraftRepoError::Invalid(e.to_string())
}
