//! Manuscripts, sections and their Yjs documents in SQLite (RAD-209), plus the comment and
//! suggestion indexes and the audit log read by the MCP server.

use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

use crate::storage::{StorageError, Store};

pub(crate) const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
pub const SECTION_KINDS: &[&str] = &["front_matter", "part", "chapter", "back_matter"];

const DECISION_KINDS: &[&str] = &["suggestion_insert", "suggestion_delete"];
const DECISION_STATUS: &[&str] = &["accepted", "rejected"];

/// Human accept/reject of a tracked-change mark (#51). Mirrors `@swarmdraft/editor` `DecisionRecord`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDecisionRecord {
    pub kind: String,
    pub id: String,
    pub status: String,
    pub decided_at: String,
    pub decided_by: String,
}

fn validate_decision_record(r: &ReviewDecisionRecord) -> Result<(), StorageError> {
    if !DECISION_KINDS.contains(&r.kind.as_str()) {
        return Err(StorageError::Invalid(format!(
            "bad decision kind: {}",
            r.kind
        )));
    }
    if !DECISION_STATUS.contains(&r.status.as_str()) {
        return Err(StorageError::Invalid(format!(
            "bad decision status: {}",
            r.status
        )));
    }
    if r.id.is_empty() || r.decided_by.is_empty() || r.decided_at.is_empty() {
        return Err(StorageError::Invalid("empty decision field".into()));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manuscript {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub numbering_style: String,
    pub book_author: Option<String>,
}

const NUMBERING_STYLES: [&str; 4] = [
    "chapter_arabic",
    "chapter_words",
    "chapter_upper",
    "number_only",
];

/// Book-wide default (#111): Chapter 1 / Part I in the editor.
pub const DEFAULT_NUMBERING_STYLE: &str = "chapter_arabic";

fn row_manuscript(r: &rusqlite::Row<'_>) -> rusqlite::Result<Manuscript> {
    Ok(Manuscript {
        id: r.get(0)?,
        title: r.get(1)?,
        created_at: r.get(2)?,
        numbering_style: r.get(3)?,
        book_author: r.get(4)?,
    })
}

const MANUSCRIPT_COLS: &str = "id, title, created_at, numbering_style, book_author";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub id: String,
    pub manuscript_id: String,
    pub kind: String,
    pub parent_id: Option<String>,
    pub position: i64,
    pub title: String,
    pub doc_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Author {
    pub kind: String,
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub section_id: String,
    pub block_id: Option<String>,
    pub quote: Option<String>,
    pub body: String,
    pub thread_id: Option<String>,
    pub author: Author,
    pub created_at: String,
    pub resolved_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub id: String,
    pub section_id: String,
    pub block_id: Option<String>,
    pub kind: String,
    pub quote: Option<String>,
    pub replacement: Option<String>,
    pub rationale: Option<String>,
    pub author: Author,
    pub status: String,
    pub created_at: String,
}

/// One section of an imported manuscript: ProseMirror JSON from the .docx importer.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ImportSection {
    /// The importer's id for this section, used only to resolve `parent_id` within the import.
    #[serde(default)]
    pub id: Option<String>,
    /// The importer's id of the parent section (an earlier section in the same import).
    #[serde(default, rename = "parentId")]
    pub parent_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub doc: Value,
}

/// A section with its full stored document state (a Yjs v1 update from an empty doc), for the
/// editor to load and then send its own updates against.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSection {
    #[serde(flatten)]
    pub section: Section,
    pub state: Vec<u8>,
}

/// A manuscript as stored: its row plus every section, in order, with document state.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredManuscript {
    pub manuscript: Manuscript,
    pub sections: Vec<StoredSection>,
    /// The last `doc_updates` seq included (read before the state, so nothing written while
    /// loading is missed). Pass it to `updates_since` to follow later writes, e.g. an agent's.
    pub updates_cursor: i64,
}

/// One stored Yjs update for a section doc.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocUpdate {
    pub doc_id: String,
    pub update: Vec<u8>,
}

/// The section updates of a manuscript written after a cursor, plus the new cursor.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatesSince {
    pub cursor: i64,
    pub updates: Vec<DocUpdate>,
}

/// At most this many updates are returned per `updates_since` call; the caller polls again.
pub const UPDATES_PAGE: i64 = 200;

/// One row of an outline save: the full outline is sent, in order (parents before children).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineEntry {
    pub id: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub doc_id: String,
}

pub fn new_id() -> String {
    let mut b = [0u8; 12];
    getrandom::fill(&mut b).expect("OS random source unavailable");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn section_doc_id(manuscript_id: &str, section_id: &str) -> String {
    format!("manuscript/{manuscript_id}/section/{section_id}")
}

fn row_section(r: &rusqlite::Row) -> rusqlite::Result<Section> {
    Ok(Section {
        id: r.get(0)?,
        manuscript_id: r.get(1)?,
        kind: r.get(2)?,
        parent_id: r.get(3)?,
        position: r.get(4)?,
        title: r.get(5)?,
        doc_id: r.get(6)?,
    })
}
const SECTION_COLS: &str = "id, manuscript_id, kind, parent_id, position, title, doc_id";

fn row_comment(r: &rusqlite::Row) -> rusqlite::Result<Comment> {
    Ok(Comment {
        id: r.get(0)?,
        section_id: r.get(1)?,
        block_id: r.get(2)?,
        quote: r.get(3)?,
        body: r.get(4)?,
        thread_id: r.get(5)?,
        author: Author {
            kind: r.get(6)?,
            id: r.get(7)?,
            name: r.get(8)?,
        },
        created_at: r.get(9)?,
        resolved_at: r.get(10)?,
    })
}
const COMMENT_COLS: &str =
    "id, section_id, block_id, quote, body, thread_id, author_kind, author_id, author_name, created_at, resolved_at";

pub(crate) fn row_suggestion(r: &rusqlite::Row<'_>) -> rusqlite::Result<Suggestion> {
    Ok(Suggestion {
        id: r.get(0)?,
        section_id: r.get(1)?,
        block_id: r.get(2)?,
        kind: r.get(3)?,
        quote: r.get(4)?,
        replacement: r.get(5)?,
        rationale: r.get(6)?,
        author: Author {
            kind: r.get(7)?,
            id: r.get(8)?,
            name: r.get(9)?,
        },
        status: r.get(10)?,
        created_at: r.get(11)?,
    })
}
pub(crate) const SUGGESTION_COLS: &str =
    "id, section_id, block_id, kind, quote, replacement, rationale, \
     author_kind, author_id, author_name, status, created_at";

impl Store {
    pub fn create_manuscript(&self, title: &str) -> Result<Manuscript, StorageError> {
        let id = new_id();
        self.with_conn(|c| {
            c.execute(
                &format!(
                    "INSERT INTO manuscripts (id, title, created_at, numbering_style, book_author) \
                     VALUES (?1, ?2, {NOW}, ?3, NULL)"
                ),
                params![id, title, DEFAULT_NUMBERING_STYLE],
            )?;
            Ok(c.query_row(
                &format!("SELECT {MANUSCRIPT_COLS} FROM manuscripts WHERE id = ?1"),
                [&id],
                row_manuscript,
            )?)
        })
    }
    /// Blank in-app draft (#243): #109 title-page row plus one empty chapter ready to type.
    pub const BLANK_DRAFT_TITLE: &str = "Untitled draft";

    pub fn create_blank_manuscript_with_progress(
        &self,
        progress: Option<&mut crate::opening_progress::Callback<'_>>,
    ) -> Result<StoredManuscript, StorageError> {
        let m = self.create_manuscript(Self::BLANK_DRAFT_TITLE)?;
        self.add_section(&m.id, "front_matter", "Title page", None)?;
        self.add_section(&m.id, "chapter", "New chapter", None)?;
        self.load_manuscript_with_progress(&m.id, progress)
    }

    pub fn create_blank_manuscript(&self) -> Result<StoredManuscript, StorageError> {
        self.create_blank_manuscript_with_progress(None)
    }

    pub fn list_manuscripts(&self) -> Result<Vec<Manuscript>, StorageError> {
        self.with_conn(|c| {
            let mut st = c.prepare(&format!(
                "SELECT {MANUSCRIPT_COLS} FROM manuscripts ORDER BY created_at, id"
            ))?;
            let rows = st
                .query_map([], row_manuscript)?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    pub fn get_manuscript(&self, id: &str) -> Result<Manuscript, StorageError> {
        self.with_conn(|c| {
            c.query_row(
                &format!("SELECT {MANUSCRIPT_COLS} FROM manuscripts WHERE id = ?1"),
                [id],
                row_manuscript,
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound(format!("manuscript {id}")))
        })
    }

    pub fn set_numbering_style(
        &self,
        manuscript_id: &str,
        style: &str,
    ) -> Result<Manuscript, StorageError> {
        if !NUMBERING_STYLES.contains(&style) {
            return Err(StorageError::Invalid(format!(
                "unknown numbering style: {style}"
            )));
        }
        self.with_conn(|c| {
            let n = c.execute(
                "UPDATE manuscripts SET numbering_style = ?2 WHERE id = ?1",
                params![manuscript_id, style],
            )?;
            if n == 0 {
                return Err(StorageError::NotFound(format!(
                    "manuscript {manuscript_id}"
                )));
            }
            Ok(c.query_row(
                &format!("SELECT {MANUSCRIPT_COLS} FROM manuscripts WHERE id = ?1"),
                [manuscript_id],
                row_manuscript,
            )?)
        })
    }

    /// Add a section at the end of the manuscript, with an empty Yjs document.
    pub fn add_section(
        &self,
        manuscript_id: &str,
        kind: &str,
        title: &str,
        parent_id: Option<&str>,
    ) -> Result<Section, StorageError> {
        if !SECTION_KINDS.contains(&kind) {
            return Err(StorageError::Invalid(format!(
                "unknown section kind: {kind}"
            )));
        }
        self.get_manuscript(manuscript_id)?;
        let id = new_id();
        let doc_id = section_doc_id(manuscript_id, &id);
        self.with_conn(|c| {
            c.execute(
                "INSERT INTO sections (id, manuscript_id, kind, parent_id, position, title, doc_id)
                 VALUES (?1, ?2, ?3, ?4,
                   (SELECT coalesce(max(position), -1) + 1 FROM sections WHERE manuscript_id = ?2),
                   ?5, ?6)",
                params![id, manuscript_id, kind, parent_id, title, doc_id],
            )?;
            Ok(c.query_row(
                &format!("SELECT {SECTION_COLS} FROM sections WHERE id = ?1"),
                [&id],
                row_section,
            )?)
        })
    }

    pub fn list_sections(&self, manuscript_id: &str) -> Result<Vec<Section>, StorageError> {
        self.get_manuscript(manuscript_id)?;
        self.with_conn(|c| {
            let mut st = c.prepare(&format!(
                "SELECT {SECTION_COLS} FROM sections WHERE manuscript_id = ?1 ORDER BY position"
            ))?;
            let rows = st
                .query_map([manuscript_id], row_section)?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    pub fn get_section(
        &self,
        manuscript_id: &str,
        section_id: &str,
    ) -> Result<Section, StorageError> {
        self.with_conn(|c| {
            c.query_row(
                &format!(
                    "SELECT {SECTION_COLS} FROM sections WHERE id = ?1 AND manuscript_id = ?2"
                ),
                [section_id, manuscript_id],
                row_section,
            )
            .optional()?
            .ok_or_else(|| {
                StorageError::NotFound(format!(
                    "section {section_id} in manuscript {manuscript_id}"
                ))
            })
        })
    }

    pub fn append_doc_update(&self, doc_id: &str, update: &[u8]) -> Result<(), StorageError> {
        self.with_conn(|c| {
            c.execute(
                "INSERT INTO doc_updates (doc_id, data) VALUES (?1, ?2)",
                params![doc_id, update],
            )?;
            Ok(())
        })
    }

    /// Load a Yjs document by replaying its stored updates.
    pub fn load_doc(&self, doc_id: &str) -> Result<Doc, StorageError> {
        let updates: Vec<Vec<u8>> = self.with_conn(|c| {
            let mut st =
                c.prepare("SELECT data FROM doc_updates WHERE doc_id = ?1 ORDER BY seq")?;
            let rows = st
                .query_map([doc_id], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })?;
        let doc = crate::content::new_doc();
        {
            let mut txn = doc.transact_mut();
            for u in updates {
                let u = Update::decode_v1(&u)
                    .map_err(|e| StorageError::Invalid(format!("bad update: {e}")))?;
                txn.apply_update(u)
                    .map_err(|e| StorageError::Invalid(format!("bad update: {e}")))?;
            }
        }
        Ok(doc)
    }

    /// Persist everything in `doc` that is newer than `since` as one update.
    pub fn save_doc_changes(
        &self,
        doc_id: &str,
        doc: &Doc,
        since: &StateVector,
    ) -> Result<(), StorageError> {
        validate_saved_doc(doc)?;
        let update = doc.transact().encode_state_as_update_v1(since);
        if update.len() > 2 {
            self.append_doc_update(doc_id, &update)?;
        }
        Ok(())
    }

    /// One agent write, all-or-nothing: in a single transaction under the connection lock,
    /// re-check that the token (and its agent) is still active, then append the doc update
    /// (validated first) and insert the comment or suggestion. A token revoked after the
    /// request authenticated is refused here and nothing is written.
    pub fn agent_write(&self, token_id: &str, w: AgentWrite<'_>) -> Result<(), StorageError> {
        let update = match w.doc {
            Some((_, doc, since)) => {
                validate_saved_doc(doc)?;
                Some(doc.transact().encode_state_as_update_v1(since))
            }
            None => None,
        };
        #[cfg(test)]
        if let Some(hook) = BEFORE_AGENT_WRITE.with(|h| h.borrow_mut().take()) {
            hook();
        }
        self.with_conn(|c| {
            let tx = c.unchecked_transaction()?;
            let active = tx
                .query_row(
                    "SELECT 1 FROM agent_tokens t JOIN agents a ON a.id = t.agent_id
                     WHERE t.id = ?1 AND t.revoked_at IS NULL AND a.revoked_at IS NULL",
                    [token_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !active {
                return Err(StorageError::Invalid(
                    "token has been revoked; nothing was written".into(),
                ));
            }
            if let (Some((doc_id, _, _)), Some(u)) = (w.doc, &update) {
                if u.len() > 2 {
                    tx.execute(
                        "INSERT INTO doc_updates (doc_id, data) VALUES (?1, ?2)",
                        params![doc_id, u],
                    )?;
                }
            }
            if let Some(c) = w.comment {
                insert_comment_on(&tx, w.manuscript_id, c)?;
            }
            if let Some(x) = w.suggestion {
                insert_suggestion_on(&tx, w.manuscript_id, x)?;
            }
            tx.commit()?;
            Ok(())
        })
    }

    /// Persist a whole imported manuscript at once: the manuscript row, every section row and
    /// each section's initial document state, in one transaction. Every section is validated
    /// and encoded before anything is written, so a bad section leaves nothing behind.
    pub fn import_manuscript(
        &self,
        title: &str,
        sections: &[ImportSection],
    ) -> Result<(Manuscript, Vec<Section>), StorageError> {
        self.import_manuscript_with_progress(title, sections, None, None)
    }

    pub fn import_manuscript_with_progress(
        &self,
        title: &str,
        sections: &[ImportSection],
        book_author: Option<&str>,
        mut progress: Option<&mut crate::opening_progress::Callback<'_>>,
    ) -> Result<(Manuscript, Vec<Section>), StorageError> {
        let chapters_found = sections.iter().filter(|s| s.kind == "chapter").count() as u32;
        if let Some(p) = &mut progress {
            p("preparing", 0, title, chapters_found);
        }
        let mut encoded = Vec::with_capacity(sections.len());
        for (i, s) in sections.iter().enumerate() {
            if !SECTION_KINDS.contains(&s.kind.as_str()) {
                return Err(StorageError::Invalid(format!(
                    "unknown section kind: {}",
                    s.kind
                )));
            }
            crate::content::validate_doc(&s.doc).map_err(StorageError::Invalid)?;
            let doc = crate::content::new_doc();
            crate::content::encode(&doc, &s.doc).map_err(StorageError::Invalid)?;
            validate_saved_doc(&doc)?;
            if let Some(p) = &s.parent_id {
                if !sections[..i].iter().any(|x| x.id.as_deref() == Some(p)) {
                    return Err(StorageError::Invalid(format!(
                        "section {:?} has unknown parent {p:?}",
                        s.title
                    )));
                }
            }
            let update = doc
                .transact()
                .encode_state_as_update_v1(&StateVector::default());
            encoded.push(update);
            if let Some(p) = &mut progress {
                let pct = crate::opening_progress::segment_percent(i, sections.len(), 0, 45);
                p("preparing", pct, title, chapters_found);
            }
        }
        let manuscript_id = new_id();
        self.with_conn(|c| {
            let tx = c.unchecked_transaction()?;
            tx.execute(
                &format!(
                    "INSERT INTO manuscripts (id, title, created_at, numbering_style, book_author) \
                     VALUES (?1, ?2, {NOW}, ?3, ?4)"
                ),
                params![manuscript_id, title, DEFAULT_NUMBERING_STYLE, book_author],
            )?;
            let mut out = Vec::with_capacity(sections.len());
            // Importer ids are only unique within one import, so every section gets a new
            // store id; parents are mapped through the ids assigned so far.
            let mut ids = std::collections::HashMap::new();
            for (i, (s, update)) in sections.iter().zip(&encoded).enumerate() {
                let id = new_id();
                let doc_id = section_doc_id(&manuscript_id, &id);
                let parent = s.parent_id.as_ref().and_then(|p| ids.get(p).cloned());
                tx.execute(
                    "INSERT INTO sections (id, manuscript_id, kind, parent_id, position, title, doc_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![id, manuscript_id, s.kind, parent, i as i64, s.title, doc_id],
                )?;
                if let Some(src) = &s.id {
                    ids.insert(src.clone(), id.clone());
                }
                if update.len() > 2 {
                    tx.execute(
                        "INSERT INTO doc_updates (doc_id, data) VALUES (?1, ?2)",
                        params![doc_id, update],
                    )?;
                }
                out.push(tx.query_row(
                    &format!("SELECT {SECTION_COLS} FROM sections WHERE id = ?1"),
                    [&id],
                    row_section,
                )?);
                if let Some(p) = &mut progress {
                    let pct = crate::opening_progress::segment_percent(i, sections.len(), 46, 75);
                    p("saving", pct, title, chapters_found);
                }
            }
            let m = tx.query_row(
                &format!("SELECT {MANUSCRIPT_COLS} FROM manuscripts WHERE id = ?1"),
                [&manuscript_id],
                row_manuscript,
            )?;
            tx.commit()?;
            Ok((m, out))
        })
    }

    /// Save the whole outline (rename, reorder, move, add, delete) in one transaction. Existing
    /// sections keep their doc; new ones get an empty doc at `section_doc_id`. Removed sections
    /// and their comment/suggestion index rows (including open agent suggestions) are deleted
    /// and an audit event records what was removed; their Yjs updates are kept in
    /// `doc_updates`. Validation reads the same state the write changes (one transaction), so
    /// a bad outline writes nothing.
    pub fn save_outline(
        &self,
        manuscript_id: &str,
        outline: &[OutlineEntry],
    ) -> Result<Vec<Section>, StorageError> {
        self.get_manuscript(manuscript_id)?;
        self.with_conn(|c| {
            let tx = c.unchecked_transaction()?;
            let existing: std::collections::HashMap<String, Section> = {
                let mut st = tx.prepare(&format!(
                    "SELECT {SECTION_COLS} FROM sections WHERE manuscript_id = ?1"
                ))?;
                let rows = st
                    .query_map([manuscript_id], row_section)?
                    .collect::<Result<Vec<_>, _>>()?;
                rows.into_iter().map(|s| (s.id.clone(), s)).collect()
            };
            validate_outline(manuscript_id, outline, &existing)?;
            let keep: std::collections::HashSet<&str> =
                outline.iter().map(|e| e.id.as_str()).collect();
            let mut removed: Vec<&Section> = existing
                .values()
                .filter(|s| !keep.contains(s.id.as_str()))
                .collect();
            removed.sort_by_key(|s| s.position);
            for s in &removed {
                tx.execute("UPDATE sections SET parent_id = NULL WHERE id = ?1", [&s.id])?;
            }
            for (i, e) in outline.iter().enumerate() {
                if existing.contains_key(&e.id) {
                    tx.execute(
                        "UPDATE sections SET kind = ?2, parent_id = ?3, position = ?4, title = ?5
                         WHERE id = ?1 AND manuscript_id = ?6",
                        params![e.id, e.kind, e.parent_id, i as i64, e.title, manuscript_id],
                    )?;
                } else {
                    tx.execute(
                        "INSERT INTO sections (id, manuscript_id, kind, parent_id, position, title, doc_id)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                        params![e.id, manuscript_id, e.kind, e.parent_id, i as i64, e.title, e.doc_id],
                    )?;
                }
            }
            if !removed.is_empty() {
                let mut gone = Vec::new();
                for s in &removed {
                    let comments = tx.execute("DELETE FROM comments WHERE section_id = ?1", [&s.id])?;
                    let open: i64 = tx.query_row(
                        "SELECT count(*) FROM suggestions WHERE section_id = ?1 AND status = 'open'",
                        [&s.id],
                        |r| r.get(0),
                    )?;
                    let suggestions =
                        tx.execute("DELETE FROM suggestions WHERE section_id = ?1", [&s.id])?;
                    tx.execute("DELETE FROM review_decisions WHERE section_id = ?1", [&s.id])?;
                    tx.execute("DELETE FROM sections WHERE id = ?1", [&s.id])?;
                    gone.push(serde_json::json!({
                        "sectionId": s.id, "title": s.title, "kind": s.kind, "docId": s.doc_id,
                        "comments": comments, "suggestions": suggestions,
                        "openSuggestions": open,
                    }));
                }
                tx.execute(
                    &format!(
                        "INSERT INTO audit_events (manuscript_id, principal_kind, principal_id, action, outcome, payload, ts)
                         VALUES (?1, 'human', 'local', 'delete_sections', 'ok', ?2, {NOW})"
                    ),
                    params![manuscript_id, serde_json::json!({ "removed": gone }).to_string()],
                )?;
            }
            tx.commit()?;
            Ok(())
        })?;
        self.list_sections(manuscript_id)
    }

    /// Load a manuscript with every section's full document state.
    pub fn load_manuscript(&self, manuscript_id: &str) -> Result<StoredManuscript, StorageError> {
        self.load_manuscript_with_progress(manuscript_id, None)
    }

    pub fn load_manuscript_with_progress(
        &self,
        manuscript_id: &str,
        mut progress: Option<&mut crate::opening_progress::Callback<'_>>,
    ) -> Result<StoredManuscript, StorageError> {
        let manuscript = self.get_manuscript(manuscript_id)?;
        let title = manuscript.title.clone();
        // Read the cursor first: anything written after it is replayed by `updates_since`
        // (re-applying an update the state already has is a no-op), so nothing is missed.
        let updates_cursor = self.updates_cursor()?;
        let section_rows = self.list_sections(manuscript_id)?;
        let total = section_rows.len().max(1);
        let chapters_found = section_rows.iter().filter(|s| s.kind == "chapter").count() as u32;
        if let Some(p) = &mut progress {
            p("loading", 76, &title, chapters_found);
        }
        let sections = section_rows
            .into_iter()
            .enumerate()
            .map(|(i, section)| {
                let doc = self.load_doc(&section.doc_id)?;
                let state = doc
                    .transact()
                    .encode_state_as_update_v1(&StateVector::default());
                if let Some(p) = &mut progress {
                    let pct = crate::opening_progress::segment_percent(i, total, 76, 99);
                    p("loading", pct, &title, chapters_found);
                }
                Ok(StoredSection { section, state })
            })
            .collect::<Result<_, StorageError>>()?;
        if let Some(p) = &mut progress {
            p("ready", 100, &title, chapters_found);
        }
        Ok(StoredManuscript {
            manuscript,
            sections,
            updates_cursor,
        })
    }

    /// The newest `doc_updates` seq (0 when empty).
    pub fn updates_cursor(&self) -> Result<i64, StorageError> {
        self.with_sql(|c| {
            c.query_row("SELECT COALESCE(MAX(seq), 0) FROM doc_updates", [], |r| {
                r.get(0)
            })
        })
    }

    /// Updates to this manuscript's section docs with seq > `after`, oldest first (at most
    /// `UPDATES_PAGE`). Lets an open editor pick up writes made elsewhere, such as an agent's
    /// suggestions and comments over MCP, without reloading.
    pub fn updates_since(
        &self,
        manuscript_id: &str,
        after: i64,
    ) -> Result<UpdatesSince, StorageError> {
        self.with_sql(|c| {
            let mut st = c.prepare(
                "SELECT u.seq, u.doc_id, u.data FROM doc_updates u
                 WHERE u.seq > ?2
                   AND (u.doc_id IN (SELECT doc_id FROM sections WHERE manuscript_id = ?1)
                        OR u.doc_id = ?4)
                 ORDER BY u.seq LIMIT ?3",
            )?;
            let notes_id = crate::notes::notes_doc_id(manuscript_id);
            let mut cursor = after;
            let updates = st
                .query_map(params![manuscript_id, after, UPDATES_PAGE, notes_id], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get(1)?, r.get(2)?))
                })?
                .map(|row| {
                    row.map(|(seq, doc_id, update)| {
                        cursor = cursor.max(seq);
                        DocUpdate { doc_id, update }
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(UpdatesSince { cursor, updates })
        })
    }

    /// The most recently created manuscript, for reopening at startup.
    pub fn latest_manuscript(&self) -> Result<Option<StoredManuscript>, StorageError> {
        self.latest_manuscript_with_progress(None)
    }

    pub fn latest_manuscript_with_progress(
        &self,
        progress: Option<&mut crate::opening_progress::Callback<'_>>,
    ) -> Result<Option<StoredManuscript>, StorageError> {
        let id: Option<String> = self.with_conn(|c| {
            Ok(c.query_row(
                "SELECT id FROM manuscripts ORDER BY created_at DESC, rowid DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()?)
        })?;
        id.map(|id| self.load_manuscript_with_progress(&id, progress))
            .transpose()
    }

    /// Save an editor update (Yjs v1) to a section. The update is applied to the stored doc
    /// and the result validated before it is appended, so a malformed edit is refused and
    /// nothing is written.
    pub fn apply_section_update(
        &self,
        manuscript_id: &str,
        section_id: &str,
        update: &[u8],
    ) -> Result<(), StorageError> {
        let s = self.get_section(manuscript_id, section_id)?;
        let decoded = Update::decode_v1(update)
            .map_err(|e| StorageError::Invalid(format!("bad update: {e}")))?;
        let doc = self.load_doc(&s.doc_id)?;
        doc.transact_mut()
            .apply_update(decoded)
            .map_err(|e| StorageError::Invalid(format!("bad update: {e}")))?;
        validate_saved_doc(&doc)?;
        if update.len() > 2 {
            self.with_conn(|c| {
                let tx = c.unchecked_transaction()?;
                tx.execute(
                    "INSERT INTO doc_updates (doc_id, data) VALUES (?1, ?2)",
                    params![s.doc_id, update],
                )?;
                upsert_human_suggestions_from_doc(&tx, manuscript_id, &s.id, &doc)?;
                tx.commit()?;
                Ok(())
            })?;
        }
        Ok(())
    }

    /// Create a section from ProseMirror JSON (e.g. the .docx importer's output).
    pub fn import_section_json(
        &self,
        manuscript_id: &str,
        kind: &str,
        title: &str,
        pm_doc: &Value,
    ) -> Result<Section, StorageError> {
        crate::content::validate_doc(pm_doc).map_err(StorageError::Invalid)?;
        let doc = crate::content::new_doc();
        crate::content::encode(&doc, pm_doc).map_err(StorageError::Invalid)?;
        let s = self.add_section(manuscript_id, kind, title, None)?;
        self.save_doc_changes(&s.doc_id, &doc, &StateVector::default())?;
        Ok(s)
    }

    pub fn open_comments(&self, section_id: &str) -> Result<Vec<Comment>, StorageError> {
        self.with_conn(|c| {
            let mut st = c.prepare(&format!(
                "SELECT {COMMENT_COLS} FROM comments WHERE section_id = ?1 AND resolved_at IS NULL
                 ORDER BY created_at, id"
            ))?;
            let rows = st
                .query_map([section_id], row_comment)?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    /// Every comment row in a section for the review sidebar (#255), including resolved threads.
    pub fn section_review_comments(&self, section_id: &str) -> Result<Vec<Comment>, StorageError> {
        self.with_conn(|c| {
            let mut st = c.prepare(&format!(
                "SELECT {COMMENT_COLS} FROM comments WHERE section_id = ?1
                 ORDER BY created_at, id"
            ))?;
            let rows = st
                .query_map([section_id], row_comment)?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    pub fn human_comment_reply(
        &self,
        manuscript_id: &str,
        section_id: &str,
        thread_id: &str,
        body: &str,
        author_name: &str,
        author_id: &str,
    ) -> Result<Comment, StorageError> {
        let body = body.trim();
        if body.is_empty() {
            return Err(StorageError::Invalid(
                "comment body must not be empty".into(),
            ));
        }
        self.get_section(manuscript_id, section_id)?;
        let anchor = self
            .with_conn(|c| {
                c.query_row(
                    &format!(
                        "SELECT {COMMENT_COLS} FROM comments
                     WHERE section_id = ?1 AND manuscript_id = ?2
                       AND (thread_id = ?3 OR (thread_id IS NULL AND id = ?3))
                     ORDER BY created_at, id LIMIT 1"
                    ),
                    params![section_id, manuscript_id, thread_id],
                    row_comment,
                )
                .optional()
                .map_err(StorageError::from)
            })?
            .ok_or_else(|| StorageError::NotFound(format!("comment thread {thread_id}")))?;
        let c = Comment {
            id: format!("c{}", new_id()),
            section_id: section_id.to_string(),
            block_id: anchor.block_id.clone(),
            quote: anchor.quote.clone(),
            body: body.to_string(),
            thread_id: Some(thread_id.to_string()),
            author: Author {
                kind: "human".into(),
                id: author_id.to_string(),
                name: author_name.to_string(),
            },
            created_at: self.now()?,
            resolved_at: None,
        };
        self.insert_comment(manuscript_id, &c)?;
        // Human reply reopens a resolved thread for MCP/open_comments (#255).
        self.set_comment_thread_resolved(manuscript_id, section_id, thread_id, false)?;
        Ok(c)
    }

    pub fn set_comment_thread_resolved(
        &self,
        manuscript_id: &str,
        section_id: &str,
        thread_id: &str,
        resolved: bool,
    ) -> Result<(), StorageError> {
        self.get_section(manuscript_id, section_id)?;
        self.with_conn(|c| {
            let n: i64 = c.query_row(
                "SELECT COUNT(*) FROM comments
                 WHERE manuscript_id = ?1 AND section_id = ?2
                   AND (thread_id = ?3 OR (thread_id IS NULL AND id = ?3))",
                params![manuscript_id, section_id, thread_id],
                |r| r.get(0),
            )?;
            if n == 0 {
                return Err(StorageError::NotFound(format!(
                    "comment thread {thread_id}"
                )));
            }
            if resolved {
                c.execute(
                    &format!(
                        "UPDATE comments SET resolved_at = {NOW}
                         WHERE manuscript_id = ?1 AND section_id = ?2
                           AND (thread_id = ?3 OR (thread_id IS NULL AND id = ?3))"
                    ),
                    params![manuscript_id, section_id, thread_id],
                )?;
            } else {
                c.execute(
                    "UPDATE comments SET resolved_at = NULL
                     WHERE manuscript_id = ?1 AND section_id = ?2
                       AND (thread_id = ?3 OR (thread_id IS NULL AND id = ?3))",
                    params![manuscript_id, section_id, thread_id],
                )?;
            }
            Ok(())
        })
    }

    /// Every unresolved comment in a manuscript, for building a .docx copy (#74).
    pub fn open_comments_for_manuscript(
        &self,
        manuscript_id: &str,
    ) -> Result<Vec<Comment>, StorageError> {
        self.with_conn(|c| {
            let mut st = c.prepare(&format!(
                "SELECT {COMMENT_COLS} FROM comments WHERE manuscript_id = ?1 AND resolved_at IS NULL
                 ORDER BY section_id, created_at, id"
            ))?;
            let rows = st
                .query_map([manuscript_id], row_comment)?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    pub fn open_suggestions(&self, section_id: &str) -> Result<Vec<Suggestion>, StorageError> {
        self.with_conn(|c| {
            let mut st = c.prepare(&format!(
                "SELECT {SUGGESTION_COLS} FROM suggestions WHERE section_id = ?1 AND status = 'open'
                 ORDER BY created_at, id"
            ))?;
            let rows = st
                .query_map([section_id], row_suggestion)?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    pub fn get_comment(&self, id: &str) -> Result<Option<Comment>, StorageError> {
        self.with_conn(|c| {
            Ok(c.query_row(
                &format!("SELECT {COMMENT_COLS} FROM comments WHERE id = ?1"),
                [id],
                row_comment,
            )
            .optional()?)
        })
    }

    pub fn get_suggestion(&self, id: &str) -> Result<Option<Suggestion>, StorageError> {
        self.with_conn(|c| {
            Ok(c.query_row(
                &format!("SELECT {SUGGESTION_COLS} FROM suggestions WHERE id = ?1"),
                [id],
                row_suggestion,
            )
            .optional()?)
        })
    }

    /// Current UTC time as stored in the database (ISO 8601 with milliseconds).
    pub fn now(&self) -> Result<String, StorageError> {
        self.with_conn(|c| Ok(c.query_row(&format!("SELECT {NOW}"), [], |r| r.get(0))?))
    }

    pub fn insert_comment(&self, manuscript_id: &str, c: &Comment) -> Result<(), StorageError> {
        self.with_conn(|conn| insert_comment_on(conn, manuscript_id, c))
    }

    pub fn insert_suggestion(
        &self,
        manuscript_id: &str,
        x: &Suggestion,
    ) -> Result<(), StorageError> {
        self.with_conn(|conn| insert_suggestion_on(conn, manuscript_id, x))
    }

    /// Record one agent (or human) action in the audit log.
    pub fn audit(
        &self,
        principal_kind: &str,
        principal_id: &str,
        manuscript_id: Option<&str>,
        action: &str,
        outcome: &str,
        payload: &Value,
    ) -> Result<(), StorageError> {
        self.with_conn(|c| {
            c.execute(
                &format!(
                    "INSERT INTO audit_events (manuscript_id, principal_kind, principal_id, action, outcome, payload, ts)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, {NOW})"
                ),
                params![manuscript_id, principal_kind, principal_id, action, outcome, payload.to_string()],
            )?;
            Ok(())
        })
    }

    /// Audit rows as (principal_id, action, outcome, payload), oldest first. Used by tests and
    /// the future audit view.
    pub fn audit_log(&self) -> Result<Vec<(String, String, String, String)>, StorageError> {
        self.with_conn(|c| {
            let mut st = c.prepare(
                "SELECT principal_id, action, outcome, payload FROM audit_events ORDER BY id",
            )?;
            let rows = st
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    /// Persisted review decisions for one section (#51).
    pub fn review_decisions_for_section(
        &self,
        section_id: &str,
    ) -> Result<Vec<ReviewDecisionRecord>, StorageError> {
        self.with_conn(|c| {
            let mut st = c.prepare(
                "SELECT kind, suggestion_id, status, decided_at, decided_by FROM review_decisions
                 WHERE section_id = ?1 ORDER BY decided_at, kind, suggestion_id",
            )?;
            let rows = st
                .query_map([section_id], |r| {
                    Ok(ReviewDecisionRecord {
                        kind: r.get(0)?,
                        id: r.get(1)?,
                        status: r.get(2)?,
                        decided_at: r.get(3)?,
                        decided_by: r.get(4)?,
                    })
                })?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    /// Every persisted review decision for a manuscript, grouped by section id (#51).
    pub fn review_decisions_for_manuscript(
        &self,
        manuscript_id: &str,
    ) -> Result<std::collections::HashMap<String, Vec<ReviewDecisionRecord>>, StorageError> {
        self.get_manuscript(manuscript_id)?;
        self.with_conn(|c| {
            let mut st = c.prepare(
                "SELECT rd.section_id, rd.kind, rd.suggestion_id, rd.status, rd.decided_at, rd.decided_by
                 FROM review_decisions rd
                 INNER JOIN sections s ON s.id = rd.section_id
                 WHERE s.manuscript_id = ?1
                 ORDER BY rd.section_id, rd.decided_at, rd.kind, rd.suggestion_id",
            )?;
            let mut out: std::collections::HashMap<String, Vec<ReviewDecisionRecord>> =
                std::collections::HashMap::new();
            let rows = st.query_map([manuscript_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    ReviewDecisionRecord {
                        kind: r.get(1)?,
                        id: r.get(2)?,
                        status: r.get(3)?,
                        decided_at: r.get(4)?,
                        decided_by: r.get(5)?,
                    },
                ))
            })?;
            for row in rows {
                let (section_id, rec) = row?;
                out.entry(section_id).or_default().push(rec);
            }
            Ok(out)
        })
    }

    /// Replace the decision log for one section (#51). Validation and the write share one transaction.
    pub fn save_section_review_decisions(
        &self,
        manuscript_id: &str,
        section_id: &str,
        records: &[ReviewDecisionRecord],
    ) -> Result<(), StorageError> {
        for r in records {
            validate_decision_record(r)?;
        }
        self.with_conn(|c| {
            let tx = c.unchecked_transaction()?;
            let owner: Option<String> = tx
                .query_row(
                    "SELECT manuscript_id FROM sections WHERE id = ?1",
                    [section_id],
                    |r| r.get(0),
                )
                .optional()?;
            match owner.as_deref() {
                Some(mid) if mid == manuscript_id => {}
                Some(_) => {
                    return Err(StorageError::Invalid(
                        "section belongs to another manuscript".into(),
                    ))
                }
                None => return Err(StorageError::NotFound(section_id.into())),
            }
            tx.execute(
                "DELETE FROM review_decisions WHERE section_id = ?1",
                [section_id],
            )?;
            for r in records {
                tx.execute(
                    "INSERT INTO review_decisions (section_id, kind, suggestion_id, status, decided_at, decided_by)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        section_id,
                        r.kind,
                        r.id,
                        r.status,
                        r.decided_at,
                        r.decided_by
                    ],
                )?;
            }
            sync_suggestion_index_for_decisions(&tx, manuscript_id, section_id, records)?;
            tx.commit()?;
            Ok(())
        })
    }
}

#[derive(Default)]
struct DocMarkRun {
    author: String,
    ts: String,
    insert: String,
    delete: String,
}

fn push_doc_suggestion_marks(
    node: &Value,
    block_id: Option<&str>,
    out: &mut Vec<(String, DocMarkRun)>,
) {
    if node["type"] == "text" {
        let text = node["text"].as_str().unwrap_or_default();
        for m in node["marks"].as_array().into_iter().flatten() {
            let ty = m["type"].as_str().unwrap_or_default();
            if ty != "suggestion_insert" && ty != "suggestion_delete" {
                continue;
            }
            let id = m["attrs"]["id"].as_str().unwrap_or_default();
            let author = m["attrs"]["author"].as_str().unwrap_or_default();
            if id.is_empty() || author.is_empty() || author.starts_with("agent:") {
                continue;
            }
            let ts = m["attrs"]["ts"].as_str().unwrap_or_default().to_string();
            let entry = out
                .iter_mut()
                .find(|(sid, _)| sid == id)
                .map(|(_, run)| run);
            let run = if let Some(r) = entry {
                r
            } else {
                out.push((id.to_string(), DocMarkRun::default()));
                &mut out.last_mut().unwrap().1
            };
            if run.author.is_empty() {
                run.author = author.to_string();
            }
            if run.ts.is_empty() && !ts.is_empty() {
                run.ts = ts;
            }
            if ty == "suggestion_insert" {
                run.insert.push_str(text);
            } else {
                run.delete.push_str(text);
            }
            let _ = block_id;
        }
        return;
    }
    for child in node["content"].as_array().into_iter().flatten() {
        push_doc_suggestion_marks(child, block_id, out);
    }
}

fn human_suggestions_in_doc(doc: &Doc, section_id: &str) -> Vec<Suggestion> {
    let mut runs: Vec<(String, DocMarkRun)> = Vec::new();
    for block in crate::content::decode(doc) {
        push_doc_suggestion_marks(&block.node, Some(&block.id), &mut runs);
    }
    let now = "1970-01-01T00:00:00.000Z";
    runs.into_iter()
        .map(|(id, run)| {
            let kind = if !run.delete.is_empty() && !run.insert.is_empty() {
                "replace"
            } else if !run.delete.is_empty() {
                "delete"
            } else {
                "insert"
            };
            Suggestion {
                id,
                section_id: section_id.to_string(),
                block_id: None,
                kind: kind.into(),
                quote: if run.delete.is_empty() {
                    None
                } else {
                    Some(run.delete)
                },
                replacement: if run.insert.is_empty() {
                    None
                } else {
                    Some(run.insert)
                },
                rationale: None,
                author: Author {
                    kind: "human".into(),
                    id: run.author.clone(),
                    name: run.author,
                },
                status: "open".into(),
                created_at: if run.ts.is_empty() {
                    now.into()
                } else {
                    run.ts
                },
            }
        })
        .collect()
}

fn upsert_human_suggestions_from_doc(
    tx: &rusqlite::Transaction<'_>,
    manuscript_id: &str,
    section_id: &str,
    doc: &Doc,
) -> Result<(), StorageError> {
    for x in human_suggestions_in_doc(doc, section_id) {
        tx.execute(
            "INSERT INTO suggestions (id, manuscript_id, section_id, block_id, kind, quote, replacement,
               rationale, author_kind, author_id, author_name, status, created_at, decided_at, decided_by)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'open', ?12, NULL, NULL)
             ON CONFLICT(id) DO UPDATE SET
               kind = excluded.kind,
               quote = excluded.quote,
               replacement = excluded.replacement,
               author_kind = excluded.author_kind,
               author_id = excluded.author_id,
               author_name = excluded.author_name,
               status = 'open',
               decided_at = NULL,
               decided_by = NULL
             WHERE suggestions.author_kind = 'human'",
            params![
                x.id,
                manuscript_id,
                x.section_id,
                x.block_id,
                x.kind,
                x.quote,
                x.replacement,
                x.rationale,
                x.author.kind,
                x.author.id,
                x.author.name,
                x.created_at,
            ],
        )?;
    }
    Ok(())
}

fn sync_suggestion_index_for_decisions(
    tx: &rusqlite::Transaction<'_>,
    manuscript_id: &str,
    section_id: &str,
    records: &[ReviewDecisionRecord],
) -> Result<(), StorageError> {
    let mut decided: std::collections::HashMap<&str, (&str, &str, &str)> =
        std::collections::HashMap::new();
    for r in records {
        decided.insert(
            r.id.as_str(),
            (
                r.status.as_str(),
                r.decided_at.as_str(),
                r.decided_by.as_str(),
            ),
        );
    }
    for (id, (status, at, by)) in &decided {
        let n = tx.execute(
            "UPDATE suggestions SET status = ?1, decided_at = ?2, decided_by = ?3
             WHERE id = ?4 AND section_id = ?5",
            params![status, at, by, id, section_id],
        )?;
        if n == 0 {
            tx.execute(
                "INSERT INTO suggestions (id, manuscript_id, section_id, block_id, kind, quote, replacement,
                   rationale, author_kind, author_id, author_name, status, created_at, decided_at, decided_by)
                 VALUES (?1, ?2, ?3, NULL, 'insert', NULL, NULL, NULL, 'human', ?4, ?4, ?5, ?6, ?6, ?7)",
                params![id, manuscript_id, section_id, by, status, at, by],
            )?;
        }
    }
    if decided.is_empty() {
        tx.execute(
            "UPDATE suggestions SET status = 'open', decided_at = NULL, decided_by = NULL
             WHERE section_id = ?1 AND status != 'open'",
            [section_id],
        )?;
    } else {
        let mut st =
            tx.prepare("SELECT id FROM suggestions WHERE section_id = ?1 AND status != 'open'")?;
        let closed: Vec<String> = st
            .query_map([section_id], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        for id in closed {
            if !decided.contains_key(id.as_str()) {
                tx.execute(
                    "UPDATE suggestions SET status = 'open', decided_at = NULL, decided_by = NULL
                     WHERE id = ?1 AND section_id = ?2 AND status NOT IN ('open', 'outdated')",
                    params![id, section_id],
                )?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
thread_local! {
    // Test-only: runs once in `agent_write` after the tool's checks and before the write
    // transaction, so a test can revoke a token in that window. Compiled out of release.
    pub(crate) static BEFORE_AGENT_WRITE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
}

/// What one agent write stores (see [`Store::agent_write`]).
pub struct AgentWrite<'a> {
    pub manuscript_id: &'a str,
    /// (doc id, edited doc, state vector it was loaded at)
    pub doc: Option<(&'a str, &'a Doc, &'a StateVector)>,
    pub comment: Option<&'a Comment>,
    pub suggestion: Option<&'a Suggestion>,
}

/// Every save of section content is schema-checked first.
fn validate_saved_doc(doc: &Doc) -> Result<(), StorageError> {
    let nodes: Vec<Value> = crate::content::decode(doc)
        .into_iter()
        .map(|b| b.node)
        .collect();
    crate::content::validate_doc(&serde_json::json!({ "type": "doc", "content": nodes }))
        .map_err(StorageError::Invalid)
}

fn insert_comment_on(
    conn: &rusqlite::Connection,
    manuscript_id: &str,
    c: &Comment,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO comments (id, manuscript_id, section_id, block_id, quote, body, thread_id,
           author_kind, author_id, author_name, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            c.id,
            manuscript_id,
            c.section_id,
            c.block_id,
            c.quote,
            c.body,
            c.thread_id,
            c.author.kind,
            c.author.id,
            c.author.name,
            c.created_at
        ],
    )?;
    Ok(())
}

fn insert_suggestion_on(
    conn: &rusqlite::Connection,
    manuscript_id: &str,
    x: &Suggestion,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO suggestions (id, manuscript_id, section_id, block_id, kind, quote, replacement,
           rationale, author_kind, author_id, author_name, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![x.id, manuscript_id, x.section_id, x.block_id, x.kind, x.quote, x.replacement,
            x.rationale, x.author.kind, x.author.id, x.author.name, x.status, x.created_at],
    )?;
    Ok(())
}

/// Current state vector of a doc (pair with `save_doc_changes`).
/// Which kinds may contain which (mirrors the editor's outline rules): chapters go in parts;
/// everything else is top level only.
fn can_nest(child: &str, parent: Option<&str>) -> bool {
    matches!((child, parent), (_, None) | ("chapter", Some("part")))
}

fn validate_outline(
    manuscript_id: &str,
    outline: &[OutlineEntry],
    existing: &std::collections::HashMap<String, Section>,
) -> Result<(), StorageError> {
    let bad = |m: String| Err(StorageError::Invalid(m));
    let mut seen: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    for e in outline {
        if !SECTION_KINDS.contains(&e.kind.as_str()) {
            return bad(format!("unknown section kind: {}", e.kind));
        }
        if e.id.is_empty() || seen.contains_key(e.id.as_str()) {
            return bad(format!("duplicate or empty section id {:?}", e.id));
        }
        let parent_kind = match &e.parent_id {
            Some(p) => match seen.get(p.as_str()) {
                Some(k) => Some(*k),
                None => return bad(format!("section {:?} has unknown parent {p:?}", e.title)),
            },
            None => None,
        };
        if !can_nest(&e.kind, parent_kind) {
            return bad(format!(
                "a {} cannot go {}",
                e.kind,
                parent_kind.map_or("at the top level".into(), |k| format!("inside a {k}"))
            ));
        }
        match existing.get(&e.id) {
            Some(s) if s.doc_id != e.doc_id => {
                return bad(format!("section {:?} changed its document", e.id));
            }
            None if e.doc_id != section_doc_id(manuscript_id, &e.id) => {
                return bad(format!("new section {:?} has a bad document id", e.id));
            }
            _ => {}
        }
        seen.insert(&e.id, &e.kind);
    }
    Ok(())
}

pub fn state_vector(doc: &Doc) -> StateVector {
    doc.transact().state_vector()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn new_manuscript_uses_chapter_arabic_numbering() {
        let tmp = tempfile::tempdir().unwrap();
        let s = Store::open(tmp.path()).unwrap();
        let m = s.create_manuscript("Sample Manuscript").unwrap();
        assert_eq!(m.numbering_style, DEFAULT_NUMBERING_STYLE);
    }

    #[test]
    fn import_section_json_validates_before_saving() {
        let tmp = tempfile::tempdir().unwrap();
        let s = Store::open(tmp.path()).unwrap();
        let m = s.create_manuscript("Sample Manuscript").unwrap();
        for bad in [
            json!({"type":"doc","content":[{"type":"table","content":[]}]}),
            json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"x","marks":[{"type":"highlight"}]}]}]}),
        ] {
            let e = s.import_section_json(&m.id, "chapter", "Bad", &bad);
            assert!(matches!(e, Err(StorageError::Invalid(_))), "{e:?}");
        }
        assert!(
            s.list_sections(&m.id).unwrap().is_empty(),
            "nothing was added"
        );
    }

    #[test]
    fn sections_and_docs_persist() {
        let tmp = tempfile::tempdir().unwrap();
        let s = Store::open(tmp.path()).unwrap();
        let m = s.create_manuscript("Sample Manuscript").unwrap();
        let pm = json!({"type":"doc","content":[{"type":"paragraph","attrs":{"style":"body"},"content":[{"type":"text","text":"Filler text."}]}]});
        let a = s.import_section_json(&m.id, "chapter", "One", &pm).unwrap();
        let b = s.add_section(&m.id, "chapter", "Two", None).unwrap();
        assert_eq!((a.position, b.position), (0, 1));
        assert_eq!(a.doc_id, format!("manuscript/{}/section/{}", m.id, a.id));
        drop(s);
        let s = Store::open(tmp.path()).unwrap();
        let blocks = crate::content::decode(&s.load_doc(&a.doc_id).unwrap());
        assert_eq!(crate::content::block_text(&blocks[0].node), "Filler text.");
        assert!(s.add_section(&m.id, "chapterz", "x", None).is_err());
        assert!(matches!(
            s.get_section(&m.id, "nope"),
            Err(StorageError::NotFound(_))
        ));
    }

    #[test]
    fn open_comments_for_manuscript_returns_only_open_rows() {
        let tmp = tempfile::tempdir().unwrap();
        let s = Store::open(tmp.path()).unwrap();
        let m = s.create_manuscript("Sample Manuscript").unwrap();
        let sec = s.import_section_json(
            &m.id,
            "chapter",
            "One",
            &json!({"type":"doc","content":[{"type":"paragraph","attrs":{"style":"body"},"content":[{"type":"text","text":"Hi."}]}]}),
        ).unwrap();
        let author = Author {
            kind: "human".into(),
            id: "u1".into(),
            name: "Ann".into(),
        };
        s.insert_comment(
            &m.id,
            &Comment {
                id: "c1".into(),
                section_id: sec.id.clone(),
                block_id: None,
                quote: None,
                body: "First".into(),
                thread_id: None,
                author: author.clone(),
                created_at: "2026-01-01T00:00:00Z".into(),
                resolved_at: None,
            },
        )
        .unwrap();
        s.insert_comment(
            &m.id,
            &Comment {
                id: "c2".into(),
                section_id: sec.id.clone(),
                block_id: None,
                quote: None,
                body: "Reply".into(),
                thread_id: Some("c1".into()),
                author,
                created_at: "2026-01-02T00:00:00Z".into(),
                resolved_at: None,
            },
        )
        .unwrap();
        let rows = s.open_comments_for_manuscript(&m.id).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].body, "First");
        assert_eq!(rows[1].thread_id.as_deref(), Some("c1"));
    }

    #[test]
    fn human_reply_and_resolve_persist_in_section_review() {
        let tmp = tempfile::tempdir().unwrap();
        let s = Store::open(tmp.path()).unwrap();
        let m = s.create_manuscript("Book").unwrap();
        let sec = s.import_section_json(
            &m.id,
            "chapter",
            "One",
            &json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Hi."}]}]}),
        ).unwrap();
        s.insert_comment(
            &m.id,
            &Comment {
                id: "thread1".into(),
                section_id: sec.id.clone(),
                block_id: None,
                quote: Some("Hi.".into()),
                body: "Root".into(),
                thread_id: None,
                author: Author {
                    kind: "agent".into(),
                    id: "a1".into(),
                    name: "Bot".into(),
                },
                created_at: "2026-01-01T00:00:00Z".into(),
                resolved_at: None,
            },
        )
        .unwrap();
        let reply = s
            .human_comment_reply(&m.id, &sec.id, "thread1", "  Thanks  ", "Mara", "local")
            .unwrap();
        assert_eq!(reply.body, "Thanks");
        assert_eq!(reply.thread_id.as_deref(), Some("thread1"));
        let rows = s.section_review_comments(&sec.id).unwrap();
        assert_eq!(rows.len(), 2);
        s.set_comment_thread_resolved(&m.id, &sec.id, "thread1", true)
            .unwrap();
        assert!(s
            .section_review_comments(&sec.id)
            .unwrap()
            .iter()
            .all(|r| r.resolved_at.is_some()));
        assert!(s.open_comments(&sec.id).unwrap().is_empty());
        s.human_comment_reply(&m.id, &sec.id, "thread1", "Reopen", "Mara", "local")
            .unwrap();
        assert_eq!(s.open_comments(&sec.id).unwrap().len(), 3);
        s.set_comment_thread_resolved(&m.id, &sec.id, "thread1", false)
            .unwrap();
        assert_eq!(s.open_comments(&sec.id).unwrap().len(), 3);
    }

    #[test]
    fn create_blank_manuscript_has_title_page_and_chapter() {
        let tmp = tempfile::tempdir().unwrap();
        let s = Store::open(tmp.path()).unwrap();
        let loaded = s.create_blank_manuscript().unwrap();
        assert_eq!(loaded.manuscript.title, Store::BLANK_DRAFT_TITLE);
        let sections = s.list_sections(&loaded.manuscript.id).unwrap();
        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0].kind, "front_matter");
        assert_eq!(sections[0].title, "Title page");
        assert_eq!(sections[1].kind, "chapter");
        assert_eq!(sections[1].title, "New chapter");
    }

    #[test]
    fn load_manuscript_reports_progress() {
        let tmp = tempfile::tempdir().unwrap();
        let s = Store::open(tmp.path()).unwrap();
        let pm = json!({"type":"doc","content":[{"type":"paragraph","attrs":{"style":"body"},"content":[{"type":"text","text":"Filler text."}]}]});
        let (m, _) = s
            .import_manuscript(
                "Progress Book",
                &[
                    ImportSection {
                        id: Some("c1".into()),
                        parent_id: None,
                        kind: "chapter".into(),
                        title: "One".into(),
                        doc: pm.clone(),
                    },
                    ImportSection {
                        id: Some("c2".into()),
                        parent_id: None,
                        kind: "chapter".into(),
                        title: "Two".into(),
                        doc: pm,
                    },
                ],
            )
            .unwrap();
        let hits = std::sync::Arc::new(std::sync::Mutex::new(Vec::<(String, u8, u32)>::new()));
        let hits_cb = std::sync::Arc::clone(&hits);
        let mut report = move |stage: &str, percent: u8, _title: &str, chapters: u32| {
            hits_cb
                .lock()
                .expect("progress lock")
                .push((stage.to_string(), percent, chapters));
        };
        s.load_manuscript_with_progress(&m.id, Some(&mut report))
            .unwrap();
        let hits = hits.lock().expect("progress lock");
        assert_eq!(hits.last().map(|h| h.0.as_str()), Some("ready"));
        assert_eq!(hits.last().map(|h| h.1), Some(100));
        assert_eq!(hits.last().map(|h| h.2), Some(2));
        assert!(hits.iter().any(|h| h.0 == "loading"));
    }
}
