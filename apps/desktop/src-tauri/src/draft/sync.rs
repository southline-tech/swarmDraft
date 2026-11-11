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
    TransactionMut, Xml, XmlElementPrelim, XmlTextPrelim,
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

/// Utf-16 offsets, in the text that stays, where an open insert was removed.
/// Reopen reads this so a keystroke typed into an inserted paragraph keeps its side.
const WITHHELD_INSERT_AT: &str = "withheldInsertAt";

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
/// An open insert removed from a paragraph that still has the writer's text records
/// its utf-16 offset, so reopen can put that insert back on the same side of the keystroke.
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
    let mut plain = 0u32;
    let mut anchors = Vec::new();
    for mut child in children.drain(..) {
        if child["type"] == "text" {
            match withheld_text(&child, status) {
                WithheldText::Drop => {
                    changed = true;
                    if is_open_suggestion_insert(&child, status) {
                        anchors.push(plain);
                    }
                }
                WithheldText::Same => {
                    plain += utf16_len(child["text"].as_str().unwrap_or(""));
                    kept.push(child);
                }
                WithheldText::Edited(next) => {
                    changed = true;
                    plain += utf16_len(next["text"].as_str().unwrap_or(""));
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
    if plain > 0 && !anchors.is_empty() {
        let text = anchors
            .iter()
            .map(|offset| offset.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let attrs = node.as_object_mut().and_then(|object| {
            object
                .entry("attrs")
                .or_insert_with(|| json!({}))
                .as_object_mut()
        });
        if let Some(attrs) = attrs {
            attrs.insert(WITHHELD_INSERT_AT.to_string(), json!(text));
        }
    }
    changed
}

fn is_open_suggestion_insert(node: &serde_json::Value, status: &HashMap<String, String>) -> bool {
    let Some(marks) = node["marks"].as_array() else {
        return false;
    };
    marks.iter().any(|mark| {
        if mark["type"] != "suggestion_insert" {
            return false;
        }
        let id = mark["attrs"]["id"].as_str().unwrap_or("");
        status.get(id).is_some_and(|state| state == "open")
    })
}

fn withheld_offsets(node: &serde_json::Value) -> Vec<u32> {
    node["attrs"][WITHHELD_INSERT_AT]
        .as_str()
        .unwrap_or("")
        .split(',')
        .filter_map(|piece| piece.parse().ok())
        .collect()
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

/// Put a suggestion that is still open back into `main_bytes` from unmerged bot tips,
/// as that branch stored it. A delete mark and a format mark are put on the words that
/// remain, including when the paragraph also gained characters or kept less than half
/// of them, and when only a short remnant such as "old phr" is left. A paragraph the
/// bot inserted is inserted there again. A keystroke in that paragraph stays in it,
/// before or after the insert, including when the paragraph is first or last. Text
/// already on `main` stays, and an inline insert stays where the bot put it. A later
/// paragraph that still has the old sentence does not take the mark. A long paragraph
/// keeps the mark after a short deletion. A rejected insert is not copied. Returns the
/// new state only when a mark was added.
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
    let mut skip = changes::suggestion_ids(&main);
    skip.retain(|id| open_ids.contains(id));
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
        let mut applied = HashSet::new();
        if merge_open_suggestions(&main, &bot, open_ids, &skip, &mut applied) {
            changed = true;
        }
        skip.extend(applied);
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

struct InsertRun {
    /// Utf-16 offset in the block's text that is not a suggestion insert.
    offset: u32,
    /// Order within the block. Same-offset runs stay in this order.
    seq: u32,
    text: String,
    marks: Vec<serde_json::Value>,
}

struct MarkRun {
    /// Utf-16 offset in the block's text that is not a suggestion insert.
    offset: u32,
    len: u32,
    marks: Vec<serde_json::Value>,
}

struct NewBlock {
    tag: String,
    attrs: Vec<(String, serde_json::Value)>,
    inserts: Vec<InsertRun>,
}

struct PendingRestore {
    block: NewBlock,
    /// The bot paragraph had no text of its own. A main paragraph sitting in that
    /// same slot is the keystroke the writer typed into it.
    shell: bool,
}

/// One open mark on a bot block, still in that block's own plain-text coordinates.
struct BotOp {
    insert: bool,
    /// Char offset in the block's text that is not a suggestion insert.
    at: usize,
    /// Exclusive end for a delete or format mark.
    end: usize,
    seq: u32,
    text: String,
    marks: Vec<serde_json::Value>,
}

/// Restore open marks from `bot` into `main`. Ids in `skip` are already on `main`
/// or were restored from an earlier bot tip. Ids this call applies are added to `applied`.
fn merge_open_suggestions(
    main: &Doc,
    bot: &Doc,
    open_ids: &HashSet<String>,
    skip: &HashSet<String>,
    applied: &mut HashSet<String>,
) -> bool {
    let main_blocks = content::decode(main);
    let bot_blocks = content::decode(bot);
    let mut splices: Vec<(usize, InsertRun)> = Vec::new();
    let mut mark_runs: Vec<(usize, MarkRun)> = Vec::new();
    let mut place: Vec<(usize, NewBlock)> = Vec::new();
    let mut pending: Vec<PendingRestore> = Vec::new();
    let mut mi = 0usize;
    let mut seen_match = false;
    for block in &bot_blocks {
        let ops = bot_ops(&block.node, open_ids, skip);
        let bot_plain = plain_text(&block.node);
        if bot_plain.is_empty() {
            if let Some(new_block) = new_block_from_inserts(&block.node, &ops) {
                pending.push(PendingRestore {
                    block: new_block,
                    shell: true,
                });
            }
            continue;
        }
        let bot_chars: Vec<char> = bot_plain.chars().collect();
        let found = main_blocks[mi..].iter().position(|candidate| {
            let main_chars: Vec<char> = plain_text(&candidate.node).chars().collect();
            align_chars(&bot_chars, &main_chars).is_some()
        });
        let Some(rel) = found else {
            if let Some(new_block) = new_block_from_inserts(&block.node, &ops) {
                pending.push(PendingRestore {
                    block: new_block,
                    shell: false,
                });
            }
            continue;
        };
        let idx = mi + rel;
        settle_pending(
            &mut pending,
            (mi, idx),
            seen_match,
            &main_blocks,
            &mut splices,
            &mut place,
            applied,
        );
        seen_match = true;
        mi = idx + 1;
        if ops.is_empty() {
            continue;
        }
        let main_plain = plain_text(&main_blocks[idx].node);
        let Some((inserts, marks)) = map_bot_ops(&bot_plain, &main_plain, &ops) else {
            continue;
        };
        note_applied(applied, &ops);
        for run in inserts {
            splices.push((idx, run));
        }
        for run in marks {
            mark_runs.push((idx, run));
        }
    }
    absorb_anchored_shells(
        &mut pending,
        &main_blocks,
        mi..main_blocks.len(),
        &mut splices,
        applied,
    );
    let tail: Vec<NewBlock> = pending.into_iter().map(|item| item.block).collect();
    let clear_anchors = main_blocks
        .iter()
        .any(|block| !withheld_offsets(&block.node).is_empty());
    if splices.is_empty()
        && mark_runs.is_empty()
        && place.is_empty()
        && tail.is_empty()
        && !clear_anchors
    {
        return false;
    }
    for block in &place {
        note_applied_block(applied, block);
    }
    for block in &tail {
        note_applied_tail(applied, block);
    }
    splices.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then(a.1.offset.cmp(&b.1.offset))
            .then(a.1.seq.cmp(&b.1.seq))
    });
    apply_open_runs(main, main_blocks.len(), &splices, &mark_runs, &place, &tail);
    true
}

/// Place insert-only paragraphs that are still waiting.
/// A paragraph that kept a keystroke in the bot's inserted paragraph carries the
/// offset where that insert was removed. The insert is put back there, including
/// when the paragraph is the first or last in the chapter, and including when the
/// keystroke was typed after the insert. Between two matched paragraphs, one shell
/// per main paragraph with no recorded offset is still that keystroke typed at the
/// start: the insert is added after it. Anything else is a new paragraph just before
/// the match.
fn settle_pending(
    pending: &mut Vec<PendingRestore>,
    gap: (usize, usize),
    between_matches: bool,
    main_blocks: &[content::Block],
    splices: &mut Vec<(usize, InsertRun)>,
    place: &mut Vec<(usize, NewBlock)>,
    applied: &mut HashSet<String>,
) {
    let (gap_start, gap_end) = gap;
    if absorb_anchored_shells(pending, main_blocks, gap_start..gap_end, splices, applied) {
        return;
    }
    let gap_len = gap_end.saturating_sub(gap_start);
    let absorb = between_matches
        && !pending.is_empty()
        && gap_len == pending.len()
        && pending.iter().all(|item| item.shell);
    if absorb {
        for (offset, item) in pending.drain(..).enumerate() {
            let main_idx = gap_start + offset;
            let end = utf16_len(&plain_text(&main_blocks[main_idx].node));
            note_applied_tail(applied, &item.block);
            for run in item.block.inserts {
                splices.push((
                    main_idx,
                    InsertRun {
                        offset: end,
                        seq: run.seq,
                        text: run.text,
                        marks: run.marks,
                    },
                ));
            }
        }
        return;
    }
    for item in pending.drain(..) {
        place.push((gap_end, item.block));
    }
}

/// Pair each waiting shell with a main paragraph that recorded where its insert was
/// removed. Returns false when the gap is not exactly those shells, so the caller
/// can keep the older placement.
fn absorb_anchored_shells(
    pending: &mut Vec<PendingRestore>,
    main_blocks: &[content::Block],
    range: std::ops::Range<usize>,
    splices: &mut Vec<(usize, InsertRun)>,
    applied: &mut HashSet<String>,
) -> bool {
    if pending.is_empty() || pending.iter().any(|item| !item.shell) {
        return false;
    }
    let anchors: Vec<(usize, Vec<u32>)> = range
        .filter_map(|idx| {
            let offsets = withheld_offsets(&main_blocks[idx].node);
            if offsets.is_empty() {
                None
            } else {
                Some((idx, offsets))
            }
        })
        .collect();
    if anchors.len() != pending.len() {
        return false;
    }
    for (item, (main_idx, offsets)) in pending.drain(..).zip(anchors) {
        let end = utf16_len(&plain_text(&main_blocks[main_idx].node));
        note_applied_tail(applied, &item.block);
        for (n, run) in item.block.inserts.into_iter().enumerate() {
            let offset = offsets.get(n).copied().unwrap_or(end);
            splices.push((
                main_idx,
                InsertRun {
                    offset,
                    seq: run.seq,
                    text: run.text,
                    marks: run.marks,
                },
            ));
        }
    }
    true
}

fn note_applied(applied: &mut HashSet<String>, ops: &[BotOp]) {
    for op in ops {
        for mark in &op.marks {
            if let Some(id) = mark_id(mark) {
                applied.insert(id);
            }
        }
    }
}

fn note_applied_block(applied: &mut HashSet<String>, block: &(usize, NewBlock)) {
    for run in &block.1.inserts {
        for mark in &run.marks {
            if let Some(id) = mark_id(mark) {
                applied.insert(id);
            }
        }
    }
}

fn note_applied_tail(applied: &mut HashSet<String>, block: &NewBlock) {
    for run in &block.inserts {
        for mark in &run.marks {
            if let Some(id) = mark_id(mark) {
                applied.insert(id);
            }
        }
    }
}

fn apply_open_runs(
    doc: &Doc,
    block_count: usize,
    splices: &[(usize, InsertRun)],
    mark_runs: &[(usize, MarkRun)],
    place: &[(usize, NewBlock)],
    tail: &[NewBlock],
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
    let clear: Vec<bool> = elements
        .iter()
        .map(|element| element.get_attribute(&txn, WITHHELD_INSERT_AT).is_some())
        .collect();
    for (element, clear) in elements.iter().zip(clear) {
        if clear {
            element.remove_attribute(&mut txn, &WITHHELD_INSERT_AT);
        }
    }
    for (idx, run) in mark_runs {
        let Some(element) = elements.get(*idx) else {
            continue;
        };
        if let Err(err) = format_run(&mut txn, element, run) {
            eprintln!("draft open left a suggestion out: {err}");
        }
    }
    for (idx, run) in splices {
        let Some(element) = elements.get(*idx) else {
            continue;
        };
        if let Err(err) = insert_run(&mut txn, element, run) {
            eprintln!("draft open left a suggestion out: {err}");
        }
    }
    // Higher indexes first, so an insert does not shift a later one.
    let mut groups: Vec<(usize, Vec<&NewBlock>)> = Vec::new();
    for (idx, block) in place {
        if let Some(group) = groups.iter_mut().find(|(at, _)| at == idx) {
            group.1.push(block);
        } else {
            groups.push((*idx, vec![block]));
        }
    }
    groups.sort_by_key(|group| std::cmp::Reverse(group.0));
    for (idx, blocks) in groups {
        for (n, block) in blocks.iter().enumerate() {
            insert_restored_block(&mut txn, &frag, Some((idx + n) as u32), block);
        }
    }
    for block in tail {
        insert_restored_block(&mut txn, &frag, None, block);
    }
}

fn insert_restored_block(
    txn: &mut TransactionMut,
    frag: &yrs::XmlFragmentRef,
    index: Option<u32>,
    block: &NewBlock,
) {
    let prelim = XmlElementPrelim::empty(block.tag.as_str());
    let element = if let Some(index) = index {
        frag.insert(txn, index, prelim)
    } else {
        frag.push_back(txn, prelim)
    };
    for (key, value) in &block.attrs {
        let any = serde_json::from_value(value.clone()).unwrap_or(Any::Null);
        element.insert_attribute(txn, key.as_str(), any);
    }
    for run in &block.inserts {
        if let Err(err) = insert_run(txn, &element, run) {
            eprintln!("draft open left a suggestion out: {err}");
        }
    }
}

fn insert_run(
    txn: &mut TransactionMut,
    element: &yrs::XmlElementRef,
    run: &InsertRun,
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

fn format_run(
    txn: &mut TransactionMut,
    element: &yrs::XmlElementRef,
    run: &MarkRun,
) -> Result<(), String> {
    let texts: Vec<_> = element
        .children(txn)
        .filter_map(|child| match child {
            XmlOut::Text(text) => Some(text),
            _ => None,
        })
        .collect();
    let end = run.offset.saturating_add(run.len);
    let mut edits = Vec::new();
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
            if !insert_mark {
                let chunk_end = plain + len;
                let overlap_start = run.offset.max(plain);
                let overlap_end = end.min(chunk_end);
                if overlap_start < overlap_end {
                    let at = index + overlap_start - plain;
                    edits.push((text.clone(), at, overlap_end - overlap_start));
                }
                plain = chunk_end;
            }
            index += len;
        }
    }
    if edits.is_empty() {
        return Err("format range missed the paragraph".into());
    }
    for (text, at, len) in edits {
        text.format(txn, at, len, marks_to_attrs(&run.marks)?);
    }
    Ok(())
}

fn bot_ops(
    node: &serde_json::Value,
    open_ids: &HashSet<String>,
    skip: &HashSet<String>,
) -> Vec<BotOp> {
    let mut ops = Vec::new();
    let mut plain = 0usize;
    let mut seq = 0u32;
    for child in node["content"].as_array().into_iter().flatten() {
        if child["type"] != "text" {
            continue;
        }
        let text = child["text"].as_str().unwrap_or("");
        let marks = child["marks"].as_array().cloned().unwrap_or_default();
        if let Some(id) = suggestion_insert_id(child) {
            if open_ids.contains(&id) && !skip.contains(&id) {
                ops.push(BotOp {
                    insert: true,
                    at: plain,
                    end: plain,
                    seq,
                    text: text.to_string(),
                    marks,
                });
                seq += 1;
            }
            continue;
        }
        let keep: Vec<serde_json::Value> = marks
            .into_iter()
            .filter(|mark| {
                let kind = mark["type"].as_str().unwrap_or("");
                if kind != "suggestion_delete" && kind != "format_change" {
                    return false;
                }
                let Some(id) = mark_id(mark) else {
                    return false;
                };
                open_ids.contains(&id) && !skip.contains(&id)
            })
            .collect();
        let n = text.chars().count();
        if !keep.is_empty() && n > 0 {
            ops.push(BotOp {
                insert: false,
                at: plain,
                end: plain + n,
                seq,
                text: String::new(),
                marks: keep,
            });
            seq += 1;
        }
        plain += n;
    }
    ops
}

fn new_block_from_inserts(node: &serde_json::Value, ops: &[BotOp]) -> Option<NewBlock> {
    let inserts: Vec<InsertRun> = ops
        .iter()
        .filter(|op| op.insert)
        .map(|op| InsertRun {
            offset: 0,
            seq: op.seq,
            text: op.text.clone(),
            marks: op.marks.clone(),
        })
        .collect();
    if inserts.is_empty() {
        return None;
    }
    let attrs = node["attrs"]
        .as_object()
        .map(|object| {
            object
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default();
    Some(NewBlock {
        tag: node["type"].as_str().unwrap_or("paragraph").to_string(),
        attrs,
        inserts,
    })
}

fn map_bot_ops(
    bot_plain: &str,
    main_plain: &str,
    ops: &[BotOp],
) -> Option<(Vec<InsertRun>, Vec<MarkRun>)> {
    let bot: Vec<char> = bot_plain.chars().collect();
    let main: Vec<char> = main_plain.chars().collect();
    let align = align_chars(&bot, &main)?;
    let utf16_at = |chars: &[char], idx: usize| -> u32 {
        chars.iter().take(idx).map(|ch| ch.len_utf16() as u32).sum()
    };
    let mut inserts = Vec::new();
    let mut marks = Vec::new();
    for op in ops {
        if op.insert {
            let main_at = insert_anchor(&align, op.at, main.len());
            inserts.push(InsertRun {
                offset: utf16_at(&main, main_at),
                seq: op.seq,
                text: op.text.clone(),
                marks: op.marks.clone(),
            });
            continue;
        }
        let Some((start, end)) = mark_anchor(&align, op.at, op.end) else {
            continue;
        };
        let offset = utf16_at(&main, start);
        let end_off = utf16_at(&main, end);
        if end_off <= offset {
            continue;
        }
        marks.push(MarkRun {
            offset,
            len: end_off - offset,
            marks: op.marks.clone(),
        });
    }
    Some((inserts, marks))
}

/// Where an insert that sat before bot character `at` belongs in `main`.
/// A deleted anchor uses the next character that is still there, then the one before it.
fn insert_anchor(align: &[Option<usize>], at: usize, main_len: usize) -> usize {
    if let Some(j) = align.get(at).copied().flatten() {
        return j;
    }
    if at < align.len() {
        if let Some(j) = align[at..].iter().copied().flatten().next() {
            return j;
        }
    }
    let before = at.min(align.len());
    if let Some(j) = align[..before].iter().rev().copied().flatten().next() {
        return (j + 1).min(main_len);
    }
    0
}

/// Main range covering the bot slice `[at, end)` after deleted characters are left out.
fn mark_anchor(align: &[Option<usize>], at: usize, end: usize) -> Option<(usize, usize)> {
    if end <= at || at >= align.len() {
        return None;
    }
    let end = end.min(align.len());
    let mut matched = align[at..end].iter().copied().flatten();
    let start = matched.next()?;
    let last = matched.last().unwrap_or(start);
    Some((start, last + 1))
}

/// Map bot characters onto `main`. A contiguous copy wins, including a keystroke around
/// it. When the writer also deleted characters, the longest stretches still shared line
/// up, including a remnant shorter than half the original sentence. `None` when this is
/// a different paragraph, so a later copy of the old sentence is left alone. Each entry
/// is that bot character's index in `main`, or `None` when it was deleted.
fn align_chars(bot: &[char], main: &[char]) -> Option<Vec<Option<usize>>> {
    if bot.is_empty() || main.is_empty() {
        return None;
    }
    if let Some(full) = align_full(bot, main) {
        return Some(full.into_iter().map(Some).collect());
    }
    let mut map = vec![None; bot.len()];
    let matched = align_shared(bot, main, &mut map, 0, 0);
    // Half of the two lengths together keeps "old phrase" and "ome" and rejects a
    // fragment such as "the". A remnant that is the whole of the shorter paragraph
    // still counts at seven characters, so "old phr" stays on that sentence.
    let half = matched.saturating_mul(4) >= bot.len() + main.len();
    let remnant = matched >= 7 && (matched == bot.len() || matched == main.len());
    if matched == 0 || !(half || remnant) {
        return None;
    }
    Some(map)
}

/// Longest shared stretches, written into `map` as bot-offset → main index.
/// A stretch shorter than two characters is noise and is not used.
fn align_shared(
    bot: &[char],
    main: &[char],
    map: &mut [Option<usize>],
    bot_off: usize,
    main_off: usize,
) -> usize {
    let Some((start_bot, start_main, len)) = longest_common_substring(bot, main) else {
        return 0;
    };
    if len < 2 {
        return 0;
    }
    for step in 0..len {
        map[bot_off + start_bot + step] = Some(main_off + start_main + step);
    }
    let left = align_shared(
        &bot[..start_bot],
        &main[..start_main],
        map,
        bot_off,
        main_off,
    );
    let right = align_shared(
        &bot[start_bot + len..],
        &main[start_main + len..],
        map,
        bot_off + start_bot + len,
        main_off + start_main + len,
    );
    left + len + right
}

/// Earliest longest common substring as `(bot start, main start, length)`.
/// A shared prefix or suffix is returned directly, so a short deletion in a long
/// paragraph does not build a table. A long middle uses a checked rolling hash.
fn longest_common_substring(bot: &[char], main: &[char]) -> Option<(usize, usize, usize)> {
    let n = bot.len();
    let m = main.len();
    if n == 0 || m == 0 {
        return None;
    }
    let prefix = bot
        .iter()
        .zip(main.iter())
        .take_while(|(left, right)| left == right)
        .count();
    let suffix = bot[prefix..]
        .iter()
        .rev()
        .zip(main[prefix..].iter().rev())
        .take_while(|(left, right)| left == right)
        .count();
    let core_n = n - prefix - suffix;
    let core_m = m - prefix - suffix;
    if prefix.max(suffix) >= core_n.min(core_m) {
        return end_match(n, m, prefix, suffix);
    }
    if n.saturating_mul(m) > 2_000_000 {
        let ends = end_match(n, m, prefix, suffix);
        let core = lcs_hash(
            &bot[prefix..prefix + core_n],
            &main[prefix..prefix + core_m],
        )
        .map(|(start_bot, start_main, len)| (prefix + start_bot, prefix + start_main, len));
        return match (ends, core) {
            (Some(end), Some(middle)) if middle.2 > end.2 => Some(middle),
            (Some(end), _) => Some(end),
            (None, middle) => middle,
        };
    }
    lcs_table(bot, main)
}

fn end_match(n: usize, m: usize, prefix: usize, suffix: usize) -> Option<(usize, usize, usize)> {
    if prefix >= suffix && prefix > 0 {
        Some((0, 0, prefix))
    } else if suffix > 0 {
        Some((n - suffix, m - suffix, suffix))
    } else {
        None
    }
}

fn lcs_table(bot: &[char], main: &[char]) -> Option<(usize, usize, usize)> {
    let m = main.len();
    let mut prev = vec![0usize; m + 1];
    let mut best_len = 0usize;
    let mut best_bot = 0usize;
    let mut best_main = 0usize;
    for (i, bot_ch) in bot.iter().enumerate() {
        let mut curr = vec![0usize; m + 1];
        for (j, main_ch) in main.iter().enumerate() {
            if bot_ch == main_ch {
                let len = prev[j] + 1;
                curr[j + 1] = len;
                if len > best_len {
                    best_len = len;
                    best_bot = i + 1 - len;
                    best_main = j + 1 - len;
                }
            }
        }
        prev = curr;
    }
    if best_len == 0 {
        None
    } else {
        Some((best_bot, best_main, best_len))
    }
}

/// Earliest longest common substring when the character table would be too large.
/// Each candidate is compared as characters, so a hash collision cannot count.
fn lcs_hash(bot: &[char], main: &[char]) -> Option<(usize, usize, usize)> {
    let limit = bot.len().min(main.len());
    if limit == 0 {
        return None;
    }
    let mut lo = 1usize;
    let mut hi = limit;
    let mut best: Option<(usize, usize, usize)> = None;
    while lo <= hi {
        let mid = lo + (hi - lo) / 2;
        if let Some((start_bot, start_main)) = find_common_window(bot, main, mid) {
            best = Some((start_bot, start_main, mid));
            lo = mid + 1;
        } else if mid == 0 {
            break;
        } else {
            hi = mid - 1;
        }
    }
    best
}

fn find_common_window(bot: &[char], main: &[char], len: usize) -> Option<(usize, usize)> {
    if len == 0 || len > bot.len() || len > main.len() {
        return None;
    }
    const BASE: u64 = 257;
    let mut pow = 1u64;
    for _ in 1..len {
        pow = pow.wrapping_mul(BASE);
    }
    let hash_at = |text: &[char], index: usize, prev: u64| -> u64 {
        if index == 0 {
            let mut hash = 0u64;
            for ch in &text[..len] {
                hash = hash.wrapping_mul(BASE).wrapping_add(*ch as u64);
            }
            hash
        } else {
            prev.wrapping_sub((text[index - 1] as u64).wrapping_mul(pow))
                .wrapping_mul(BASE)
                .wrapping_add(text[index + len - 1] as u64)
        }
    };
    let mut by_hash: HashMap<u64, Vec<usize>> = HashMap::new();
    let mut main_hash = 0u64;
    for index in 0..=main.len() - len {
        main_hash = hash_at(main, index, main_hash);
        by_hash.entry(main_hash).or_default().push(index);
    }
    let mut bot_hash = 0u64;
    for index in 0..=bot.len() - len {
        bot_hash = hash_at(bot, index, bot_hash);
        let Some(hits) = by_hash.get(&bot_hash) else {
            continue;
        };
        for &main_at in hits {
            if bot[index..index + len] == main[main_at..main_at + len] {
                return Some((index, main_at));
            }
        }
    }
    None
}

/// Map every bot character onto `main`. Prefer a contiguous copy, then the alignment
/// that keeps the longest runs together. `None` when `bot` is not a subsequence.
fn align_full(bot: &[char], main: &[char]) -> Option<Vec<usize>> {
    let n = bot.len();
    let m = main.len();
    if n == 0 {
        return Some(Vec::new());
    }
    if n > m {
        return None;
    }
    if let Some(start) = (0..=m - n).find(|&start| main[start..start + n] == bot[..]) {
        return Some((start..start + n).collect());
    }
    if n.saturating_mul(m) > 2_000_000 {
        return align_greedy(bot, main);
    }
    const NONE: i32 = i32::MIN / 4;
    let mut score = vec![vec![NONE; m]; n];
    let mut parent: Vec<Vec<Option<usize>>> = vec![vec![None; m]; n];
    for (j, ch) in main.iter().enumerate() {
        if *ch == bot[0] {
            score[0][j] = 0;
        }
    }
    for i in 1..n {
        let mut best = NONE;
        let mut best_j: Option<usize> = None;
        for j in 0..m {
            if main[j] == bot[i] {
                let mut next = best;
                let mut prev = best_j;
                if j > 0 && score[i - 1][j - 1] > NONE / 2 {
                    let adjacent = score[i - 1][j - 1].saturating_add(1);
                    if adjacent > next {
                        next = adjacent;
                        prev = Some(j - 1);
                    }
                }
                if next > NONE / 2 && prev.is_some() {
                    score[i][j] = next;
                    parent[i][j] = prev;
                }
            }
            if score[i - 1][j] > best {
                best = score[i - 1][j];
                best_j = Some(j);
            }
        }
    }
    let mut end_j = None;
    let mut best = NONE;
    for (j, cell) in score[n - 1].iter().enumerate() {
        if *cell > best {
            best = *cell;
            end_j = Some(j);
        }
    }
    let mut j = end_j?;
    let mut out = vec![0usize; n];
    for i in (0..n).rev() {
        out[i] = j;
        if i == 0 {
            break;
        }
        j = parent[i][j]?;
    }
    if out.windows(2).any(|pair| pair[0] >= pair[1]) {
        return None;
    }
    if out.iter().zip(bot).any(|(&at, ch)| main[at] != *ch) {
        return None;
    }
    Some(out)
}

fn align_greedy(bot: &[char], main: &[char]) -> Option<Vec<usize>> {
    let mut out = Vec::with_capacity(bot.len());
    let mut from = 0usize;
    for ch in bot {
        let found = main[from..].iter().position(|candidate| candidate == ch)?;
        let at = from + found;
        out.push(at);
        from = at + 1;
    }
    Some(out)
}

fn mark_id(mark: &serde_json::Value) -> Option<String> {
    let id = mark["attrs"]["id"].as_str().unwrap_or("");
    if id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
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
