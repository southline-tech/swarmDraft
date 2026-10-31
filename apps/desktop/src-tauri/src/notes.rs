//! Per-manuscript story notes (issue #38): one Yjs doc per book at `manuscript/{id}/notes`.

use rusqlite::params;
use serde::Serialize;
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, Transact, Update};

use crate::storage::{StorageError, Store};

pub fn notes_doc_id(manuscript_id: &str) -> String {
    format!("manuscript/{manuscript_id}/notes")
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
        self.load_doc(&notes_doc_id(manuscript_id))
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
}
