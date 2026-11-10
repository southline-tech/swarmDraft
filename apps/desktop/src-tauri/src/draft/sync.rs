//! Bidirectional sync between SQLite / Yjs and the on-disk git working tree.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::json;
use yrs::{Array, Doc, Map, MapPrelim, ReadTxn, StateVector, Transact};

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
    for section in store.list_sections(manuscript_id).map_err(storage_err)? {
        if section.kind != "chapter" {
            continue;
        }
        let yjs_path = worktree.join("yjs").join(format!("{}.bin", section.id));
        if !yjs_path.is_file() {
            continue;
        }
        let state = fs::read(&yjs_path)?;
        store
            .replace_doc_state(&section.doc_id, &state)
            .map_err(storage_err)?;
    }
    import_notes_from_worktree(store, manuscript_id, worktree)?;
    import_comments_from_worktree(store, manuscript_id, worktree)?;
    import_decisions_from_worktree(store, manuscript_id, worktree)?;
    Ok(())
}

/// Bot comments and document updates saved in SQLite and not yet on a `bot/*` commit.
/// A main checkpoint passes these so it does not publish them before that branch exists.
#[derive(Default)]
pub(crate) struct SyncOmit {
    pub comment_ids: HashSet<String>,
    /// Exact `doc_updates` bytes still waiting for a `bot/*` commit, keyed by doc id.
    pub doc_updates: HashMap<String, Vec<Vec<u8>>>,
    /// Suggestion ids already known to belong to a pending bot write. A checkpoint
    /// omits these even after open squashes the update log and the bytes above no
    /// longer match a row.
    pub change_ids: HashSet<String>,
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
        let (doc, ids) =
            chapter_doc_for_sync(store, &section.doc_id, omit, &mut pending_change_ids)?;
        if !ids.is_empty() {
            discovered.insert(section.doc_id.clone(), ids);
        }
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
    // An accept or reject is stored in sqlite before this sync. That id stays in the
    // index even when the suggestion bytes are still waiting for a `bot/*` commit.
    let pending_change_ids = without_decided_changes(store, manuscript_id, pending_change_ids)?;
    changes::write_change_index(store, manuscript_id, worktree, &pending_change_ids)?;
    Ok(discovered)
}

/// Suggestion ids with an accept or reject already recorded. Those rows are the
/// decision, so a checkpoint must not leave them out of `review/changes.json`.
fn without_decided_changes(
    store: &Store,
    manuscript_id: &str,
    mut ids: HashSet<String>,
) -> Result<HashSet<String>, DraftRepoError> {
    if ids.is_empty() {
        return Ok(ids);
    }
    let decisions = store
        .review_decisions_for_manuscript(manuscript_id)
        .map_err(storage_err)?;
    let mut decided = HashSet::new();
    for records in decisions.values() {
        for record in records {
            if record.status == "accepted" || record.status == "rejected" {
                decided.insert(record.id.clone());
            }
        }
    }
    if decided.is_empty() {
        return Ok(ids);
    }
    ids.retain(|id| !decided.contains(id));
    Ok(ids)
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

pub(crate) struct GitComment {
    pub comment: Comment,
    pub deleted_at: Option<String>,
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
    let path = worktree.join("review").join("changes.json");
    if !path.is_file() {
        store
            .replace_manuscript_review_decisions(manuscript_id, &[])
            .map_err(storage_err)?;
        return Ok(());
    }
    let bytes = fs::read(&path)?;
    let entries = match changes::parse_change_index(&bytes) {
        Ok(entries) => entries,
        Err(()) => {
            eprintln!(
                "draft change index skipped (unreadable): {}",
                path.display()
            );
            return Ok(());
        }
    };
    let mut records = Vec::new();
    for entry in entries {
        if entry.status != "accepted" && entry.status != "rejected" {
            continue;
        }
        if entry.section_id.is_empty() || entry.id.is_empty() {
            continue;
        }
        let decided_by = entry
            .decided_by
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "author".into());
        let decided_at = entry
            .decided_at
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".into());
        records.push((
            entry.section_id.clone(),
            ReviewDecisionRecord {
                kind: map_kind(&entry.kind).into(),
                id: entry.id,
                status: entry.status,
                decided_at,
                decided_by,
            },
        ));
    }
    store
        .replace_manuscript_review_decisions(manuscript_id, &records)
        .map_err(storage_err)?;
    Ok(())
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
