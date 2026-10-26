//! Manuscripts, sections and their Yjs documents in SQLite (RAD-209), plus the comment and
//! suggestion indexes and the audit log read by the MCP server.

use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

use crate::storage::{StorageError, Store};

pub(crate) const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
pub const SECTION_KINDS: &[&str] = &["front_matter", "part", "chapter", "scene", "back_matter"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manuscript {
    pub id: String,
    pub title: String,
    pub created_at: String,
}

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
    })
}
const COMMENT_COLS: &str =
    "id, section_id, block_id, quote, body, thread_id, author_kind, author_id, author_name, created_at";

fn row_suggestion(r: &rusqlite::Row) -> rusqlite::Result<Suggestion> {
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
const SUGGESTION_COLS: &str = "id, section_id, block_id, kind, quote, replacement, rationale, \
     author_kind, author_id, author_name, status, created_at";

impl Store {
    pub fn create_manuscript(&self, title: &str) -> Result<Manuscript, StorageError> {
        let id = new_id();
        self.with_conn(|c| {
            c.execute(
                &format!("INSERT INTO manuscripts (id, title, created_at) VALUES (?1, ?2, {NOW})"),
                params![id, title],
            )?;
            Ok(c.query_row(
                "SELECT id, title, created_at FROM manuscripts WHERE id = ?1",
                [&id],
                |r| {
                    Ok(Manuscript {
                        id: r.get(0)?,
                        title: r.get(1)?,
                        created_at: r.get(2)?,
                    })
                },
            )?)
        })
    }

    pub fn list_manuscripts(&self) -> Result<Vec<Manuscript>, StorageError> {
        self.with_conn(|c| {
            let mut st =
                c.prepare("SELECT id, title, created_at FROM manuscripts ORDER BY created_at, id")?;
            let rows = st
                .query_map([], |r| {
                    Ok(Manuscript {
                        id: r.get(0)?,
                        title: r.get(1)?,
                        created_at: r.get(2)?,
                    })
                })?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    pub fn get_manuscript(&self, id: &str) -> Result<Manuscript, StorageError> {
        self.with_conn(|c| {
            c.query_row(
                "SELECT id, title, created_at FROM manuscripts WHERE id = ?1",
                [id],
                |r| {
                    Ok(Manuscript {
                        id: r.get(0)?,
                        title: r.get(1)?,
                        created_at: r.get(2)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound(format!("manuscript {id}")))
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
        let update = doc.transact().encode_state_as_update_v1(since);
        if update.len() > 2 {
            self.append_doc_update(doc_id, &update)?;
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
}

/// Current state vector of a doc (pair with `save_doc_changes`).
pub fn state_vector(doc: &Doc) -> StateVector {
    doc.transact().state_vector()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
}
