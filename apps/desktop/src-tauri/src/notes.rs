//! Per-manuscript story notes (issue #38): one Yjs doc per book at `manuscript/{id}/notes`.
//!
//! Y.Doc layout matches `apps/desktop/src/notes/doc.ts`: `order` (array of note ids) and
//! `entries` (map id → metadata map). Each note body lives in XmlFragment `body:{id}`.

use getrandom::fill as random_bytes;
use rusqlite::params;
use rusqlite::OptionalExtension;
use serde::Serialize;
use serde_json::{json, Value};
use yrs::updates::decoder::Decode;
use yrs::{
    Any, Array, Doc, Map, MapPrelim, MapRef, Out, ReadTxn, StateVector, Transact, Update, WriteTxn,
};

use crate::content;
use crate::manuscripts::Author;
use crate::storage::{StorageError, Store};

pub const ORDER_KEY: &str = "order";
pub const ENTRIES_KEY: &str = "entries";
pub const MAX_NOTE_TITLE: usize = 200;
pub const MAX_NOTE_BODY: usize = 4000;

pub fn notes_doc_id(manuscript_id: &str) -> String {
    format!("manuscript/{manuscript_id}/notes")
}

pub fn body_field(note_id: &str) -> String {
    format!("body:{note_id}")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteEntry {
    pub id: String,
    pub title: String,
    pub section_id: Option<String>,
    pub author_kind: String,
    pub author_id: String,
    pub author_name: String,
    pub created_at: String,
    pub updated_at: String,
}

fn out_str(out: Out) -> Option<String> {
    match out {
        Out::Any(any) => match any {
            Any::String(s) => Some(s.to_string()),
            Any::Bool(b) => Some(b.to_string()),
            _ => None,
        },
        _ => None,
    }
}

fn read_entry_meta(txn: &yrs::Transaction, entries: &MapRef, id: &str) -> Option<NoteEntry> {
    let Out::YMap(m) = entries.get(txn, id)? else {
        return None;
    };
    let title = m.get(txn, "title").and_then(out_str).unwrap_or_default();
    let section_id = m
        .get(txn, "sectionId")
        .and_then(out_str)
        .filter(|s| !s.is_empty());
    let author_kind = m
        .get(txn, "authorKind")
        .and_then(out_str)
        .unwrap_or_else(|| "human".into());
    let author_kind = if author_kind == "agent" {
        "agent".into()
    } else {
        "human".into()
    };
    Some(NoteEntry {
        id: id.to_string(),
        title,
        section_id,
        author_kind,
        author_id: m.get(txn, "authorId").and_then(out_str).unwrap_or_default(),
        author_name: m
            .get(txn, "authorName")
            .and_then(out_str)
            .unwrap_or_default(),
        created_at: m
            .get(txn, "createdAt")
            .and_then(out_str)
            .unwrap_or_default(),
        updated_at: m
            .get(txn, "updatedAt")
            .and_then(out_str)
            .unwrap_or_default(),
    })
}

/// List story notes in display order from a notes Y.Doc.
pub fn list_note_entries(doc: &Doc) -> Vec<NoteEntry> {
    let txn = doc.transact();
    let Some(order) = txn.get_array(ORDER_KEY) else {
        return Vec::new();
    };
    let Some(entries) = txn.get_map(ENTRIES_KEY) else {
        return Vec::new();
    };
    let len = order.len(&txn);
    let mut out = Vec::new();
    for i in 0..len {
        let Some(id) = order.get(&txn, i).and_then(out_str) else {
            continue;
        };
        if let Some(meta) = read_entry_meta(&txn, &entries, &id) {
            out.push(meta);
        }
    }
    out
}

pub fn new_note_id() -> String {
    let mut b = [0u8; 8];
    random_bytes(&mut b).expect("random note id");
    format!(
        "note-{}",
        b.iter().map(|x| format!("{x:02x}")).collect::<String>()
    )
}

fn body_to_pm(body: &str) -> Value {
    let lines: Vec<&str> = if body.is_empty() {
        vec![""]
    } else {
        body.split('\n').collect()
    };
    let content: Vec<Value> = lines
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

/// Append one agent-authored note (metadata + body) and persist via [`Store::agent_notes_write`].
pub fn write_agent_note(
    store: &Store,
    token_id: &str,
    manuscript_id: &str,
    author: &Author,
    title: &str,
    body: &str,
    section_id: Option<&str>,
) -> Result<NoteEntry, StorageError> {
    if title.trim().is_empty() {
        return Err(StorageError::Invalid("title must not be empty".into()));
    }
    if author.kind != "agent" {
        return Err(StorageError::Invalid(
            "write_agent_note requires an agent author".into(),
        ));
    }
    if let Some(sid) = section_id {
        store.get_section(manuscript_id, sid)?;
    }
    content::validate_doc(&body_to_pm(body)).map_err(StorageError::Invalid)?;
    let doc = store.load_notes_doc(manuscript_id)?;
    let since = {
        let txn = doc.transact();
        txn.state_vector()
    };
    let id = new_note_id();
    let now = store.now()?;
    let body_name = body_field(&id);
    {
        let mut txn = doc.transact_mut();
        let entry = MapPrelim::from([
            ("title", title),
            ("sectionId", section_id.unwrap_or("")),
            ("authorKind", "agent"),
            ("authorId", author.id.as_str()),
            ("authorName", author.name.as_str()),
            ("createdAt", now.as_str()),
            ("updatedAt", now.as_str()),
        ]);
        txn.get_or_insert_map(ENTRIES_KEY)
            .insert(&mut txn, id.as_str(), entry);
        txn.get_or_insert_array(ORDER_KEY)
            .push_back(&mut txn, id.as_str());
        txn.get_or_insert_xml_fragment(body_name.as_str());
    }
    content::encode_fragment(&doc, body_name.as_str(), &body_to_pm(body))
        .map_err(StorageError::Invalid)?;
    store.agent_notes_write(token_id, manuscript_id, &doc, &since)?;
    Ok(NoteEntry {
        id,
        title: title.to_string(),
        section_id: section_id.map(str::to_string),
        author_kind: "agent".into(),
        author_id: author.id.clone(),
        author_name: author.name.clone(),
        created_at: now.clone(),
        updated_at: now,
    })
}

impl Store {
    fn ensure_manuscript_exists(&self, manuscript_id: &str) -> Result<(), StorageError> {
        self.with_conn(|c| {
            let n: i64 = c.query_row(
                "SELECT COUNT(*) FROM manuscripts WHERE id = ?1",
                [manuscript_id],
                |r| r.get(0),
            )?;
            if n == 0 {
                return Err(StorageError::NotFound(format!(
                    "manuscript not found: {manuscript_id}"
                )));
            }
            Ok(())
        })
    }
    /// Load the notes Y.Doc for a manuscript (empty when never written).
    pub fn load_notes_doc(&self, manuscript_id: &str) -> Result<Doc, StorageError> {
        self.ensure_manuscript_exists(manuscript_id)?;
        let doc = self.load_doc(&notes_doc_id(manuscript_id))?;
        {
            let mut txn = doc.transact_mut();
            txn.get_or_insert_array(ORDER_KEY);
            txn.get_or_insert_map(ENTRIES_KEY);
        }
        Ok(doc)
    }

    /// Append one editor update to the notes doc (validated as Yjs v1).
    pub fn apply_notes_update(
        &self,
        manuscript_id: &str,
        update: &[u8],
    ) -> Result<(), StorageError> {
        self.ensure_manuscript_exists(manuscript_id)?;
        let doc_id = notes_doc_id(manuscript_id);
        let decoded = Update::decode_v1(update)
            .map_err(|e| StorageError::Invalid(format!("bad update: {e}")))?;
        let doc = self.load_doc(&doc_id)?;
        doc.transact_mut()
            .apply_update(decoded)
            .map_err(|e| StorageError::Invalid(format!("bad update: {e}")))?;
        if update.len() > 2 {
            self.append_doc_update(&doc_id, update)?;
        }
        Ok(())
    }

    /// Replace the notes doc from a full state vector (import / tests).
    pub fn save_notes_state(&self, manuscript_id: &str, state: &[u8]) -> Result<(), StorageError> {
        self.ensure_manuscript_exists(manuscript_id)?;
        let doc_id = notes_doc_id(manuscript_id);
        let doc = self.load_doc(&doc_id)?;
        let decoded = Update::decode_v1(state)
            .map_err(|e| StorageError::Invalid(format!("bad state: {e}")))?;
        doc.transact_mut()
            .apply_update(decoded)
            .map_err(|e| StorageError::Invalid(format!("bad state: {e}")))?;
        self.save_doc_changes(&doc_id, &doc, &yrs::StateVector::default())?;
        Ok(())
    }

    /// Agent MCP write to the notes doc: token re-checked in the same transaction as the update.
    pub fn agent_notes_write(
        &self,
        token_id: &str,
        manuscript_id: &str,
        doc: &Doc,
        since: &StateVector,
    ) -> Result<(), StorageError> {
        self.ensure_manuscript_exists(manuscript_id)?;
        let update = doc.transact().encode_state_as_update_v1(since);
        let doc_id = notes_doc_id(manuscript_id);
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
            if update.len() > 2 {
                tx.execute(
                    "INSERT INTO doc_updates (doc_id, data) VALUES (?1, ?2)",
                    params![doc_id, update],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesState {
    pub state: Vec<u8>,
    pub updates_cursor: i64,
}

impl Store {
    /// Full notes doc state plus the doc_updates cursor (for live polling).
    pub fn load_notes_state(&self, manuscript_id: &str) -> Result<NotesState, StorageError> {
        self.ensure_manuscript_exists(manuscript_id)?;
        let doc_id = notes_doc_id(manuscript_id);
        let doc = self.load_doc(&doc_id)?;
        let txn = doc.transact();
        let state = txn.encode_state_as_update_v1(&yrs::StateVector::default());
        let cursor: i64 = self.with_conn(|c| {
            Ok(c.query_row(
                "SELECT COALESCE(MAX(seq), 0) FROM doc_updates WHERE doc_id = ?1",
                params![doc_id],
                |r| r.get(0),
            )?)
        })?;
        Ok(NotesState {
            state,
            updates_cursor: cursor,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content;
    use crate::manuscripts;
    use serde_json::json;
    use yrs::StateVector;

    fn temp_store() -> Store {
        Store::open(tempfile::tempdir().unwrap().path()).unwrap()
    }

    fn sample_notes_state() -> Vec<u8> {
        let doc = content::new_doc();
        content::encode(
            &doc,
            &json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"plan"}]}]}),
        )
        .unwrap();
        let txn = doc.transact();
        txn.encode_state_as_update_v1(&StateVector::default())
    }

    #[test]
    fn notes_state_round_trips_through_storage() {
        let store = temp_store();
        let m = store.create_manuscript("Notes book").unwrap();
        let state = sample_notes_state();
        store.save_notes_state(&m.id, &state).unwrap();
        let loaded = store.load_notes_state(&m.id).unwrap();
        let doc = store.load_notes_doc(&m.id).unwrap();
        let blocks = content::decode(&doc);
        let view = content::read_view(&blocks);
        assert!(view.text.contains("plan"));
        assert!(!loaded.state.is_empty());
    }

    #[test]
    fn notes_update_appends_and_merges() {
        let store = temp_store();
        let m = store.create_manuscript("Notes book").unwrap();
        store
            .save_notes_state(&m.id, &sample_notes_state())
            .unwrap();
        let base = store.load_notes_doc(&m.id).unwrap();
        let sv = base.transact().state_vector();
        let edit = content::new_doc();
        content::encode(
            &edit,
            &json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"plan more"}]}]}),
        )
        .unwrap();
        let delta = edit.transact().encode_state_as_update_v1(&sv);
        store.apply_notes_update(&m.id, &delta).unwrap();
        let doc = store.load_notes_doc(&m.id).unwrap();
        let blocks = content::decode(&doc);
        let view = content::read_view(&blocks);
        assert!(view.text.contains("more"));
    }

    #[test]
    fn notes_rejects_bad_manuscript() {
        let store = temp_store();
        let err = store
            .apply_notes_update("missing", &[1, 2, 3, 4])
            .unwrap_err()
            .to_string();
        assert!(err.contains("not found"));
    }

    #[test]
    fn notes_doc_id_matches_section_pattern() {
        let id = manuscripts::new_id();
        assert_eq!(notes_doc_id(&id), format!("manuscript/{id}/notes"));
    }

    #[test]
    fn agent_write_note_lists_with_agent_kind() {
        let store = temp_store();
        let m = store.create_manuscript("Notes book").unwrap();
        let sec = store
            .import_section_json(
                &m.id,
                "chapter",
                "One",
                &json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"x"}]}]}),
            )
            .unwrap();
        let agent = store.create_agent("Sample Bot", "#3366ff").unwrap();
        let tok = store
            .create_token(&agent.id, Some(&["comment".to_string()]))
            .unwrap();
        let author = manuscripts::Author {
            kind: "agent".into(),
            id: agent.id.clone(),
            name: agent.name.clone(),
        };
        let written = write_agent_note(
            &store,
            &tok.info.id,
            &m.id,
            &author,
            "Beat sheet",
            "Opening beat",
            Some(&sec.id),
        )
        .unwrap();
        assert_eq!(written.author_kind, "agent");
        assert_eq!(written.section_id.as_deref(), Some(sec.id.as_str()));
        let doc = store.load_notes_doc(&m.id).unwrap();
        let listed = list_note_entries(&doc);
        assert_eq!(listed, vec![written]);
    }
}
