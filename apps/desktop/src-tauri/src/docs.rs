//! Local persistence for per-section Yjs documents (RAD-203).
//!
//! Each section has its own Y.Doc, stored as an append-only log of Yjs v1 updates in
//! `doc_updates` (schema migration 3, RAD-209). The desktop editor appends its batched
//! autosave updates here and pulls anything newer (for example an agent's comment or
//! suggestion written by the MCP server) as a diff against its own state vector.
//! Compaction replaces a document's log with one merged update in a single transaction.

use rusqlite::{params, OptionalExtension};
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{ReadTxn, StateVector, Transact, Update};

use crate::storage::{StorageError, Store};

/// Largest single update accepted from the editor (an autosave batch).
pub const MAX_UPDATE_BYTES: usize = 16 * 1024 * 1024;
/// Compact a document once its log has this many rows.
pub const COMPACT_AFTER: i64 = 500;

impl Store {
    fn require_section_doc(&self, doc_id: &str) -> Result<(), StorageError> {
        let found: Option<i64> = self.with_conn(|c| {
            Ok(
                c.query_row("SELECT 1 FROM sections WHERE doc_id = ?1", [doc_id], |r| {
                    r.get(0)
                })
                .optional()?,
            )
        })?;
        found
            .map(|_| ())
            .ok_or_else(|| StorageError::NotFound(format!("document {doc_id}")))
    }

    /// Everything in the stored document that `state_vector` (Yjs v1 encoding) has not seen.
    /// An empty state vector returns the whole document.
    pub fn doc_diff(&self, doc_id: &str, state_vector: &[u8]) -> Result<Vec<u8>, StorageError> {
        self.require_section_doc(doc_id)?;
        let sv = if state_vector.is_empty() {
            StateVector::default()
        } else {
            StateVector::decode_v1(state_vector)
                .map_err(|e| StorageError::Invalid(format!("bad state vector: {e}")))?
        };
        let doc = self.load_doc(doc_id)?;
        let diff = doc.transact().encode_state_as_update_v1(&sv);
        Ok(diff)
    }

    /// Append one editor update after checking that it decodes. Compacts long logs.
    pub fn doc_append(&self, doc_id: &str, update: &[u8]) -> Result<(), StorageError> {
        self.require_section_doc(doc_id)?;
        if update.len() > MAX_UPDATE_BYTES {
            return Err(StorageError::Invalid("update too large".into()));
        }
        Update::decode_v1(update).map_err(|e| StorageError::Invalid(format!("bad update: {e}")))?;
        self.append_doc_update(doc_id, update)?;
        if self.doc_update_count(doc_id)? >= COMPACT_AFTER {
            self.compact_doc(doc_id)?;
        }
        Ok(())
    }

    pub fn doc_update_count(&self, doc_id: &str) -> Result<i64, StorageError> {
        self.with_conn(|c| {
            Ok(c.query_row(
                "SELECT COUNT(*) FROM doc_updates WHERE doc_id = ?1",
                [doc_id],
                |r| r.get(0),
            )?)
        })
    }

    /// Replace a document's update log with one merged update. Reads, deletes and inserts
    /// under one connection lock and one transaction, so no concurrent append is lost.
    pub fn compact_doc(&self, doc_id: &str) -> Result<(), StorageError> {
        self.with_conn(|c| {
            let tx = c.unchecked_transaction()?;
            let rows: Vec<Vec<u8>> = {
                let mut st =
                    tx.prepare("SELECT data FROM doc_updates WHERE doc_id = ?1 ORDER BY seq")?;
                let r = st
                    .query_map([doc_id], |r| r.get(0))?
                    .collect::<Result<_, _>>()?;
                r
            };
            if rows.len() < 2 {
                return Ok(());
            }
            let doc = yrs::Doc::new();
            {
                let mut txn = doc.transact_mut();
                for u in rows {
                    let u = Update::decode_v1(&u)
                        .map_err(|e| StorageError::Invalid(format!("bad update: {e}")))?;
                    txn.apply_update(u)
                        .map_err(|e| StorageError::Invalid(format!("bad update: {e}")))?;
                }
            }
            let merged = doc
                .transact()
                .encode_state_as_update_v1(&StateVector::default());
            tx.execute("DELETE FROM doc_updates WHERE doc_id = ?1", [doc_id])?;
            tx.execute(
                "INSERT INTO doc_updates (doc_id, data) VALUES (?1, ?2)",
                params![doc_id, merged],
            )?;
            tx.commit()?;
            Ok(())
        })
    }
}

/// Encode a state vector (helper for tests and callers holding a yrs Doc).
pub fn encode_state_vector(doc: &yrs::Doc) -> Vec<u8> {
    doc.transact().state_vector().encode_v1()
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{Doc, GetString, Text};

    fn store_with_section() -> (tempfile::TempDir, Store, String) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let m = store.create_manuscript("Synthetic").unwrap();
        let s = store.add_section(&m.id, "chapter", "One", None).unwrap();
        let doc_id = s.doc_id.clone();
        (dir, store, doc_id)
    }

    fn update_inserting(doc: &Doc, text: &str) -> Vec<u8> {
        let before = doc.transact().state_vector();
        let t = doc.get_or_insert_text("t");
        let len = t.get_string(&doc.transact()).len() as u32;
        t.insert(&mut doc.transact_mut(), len, text);
        doc.transact().encode_state_as_update_v1(&before)
    }

    fn text_of(update: &[u8]) -> String {
        let doc = Doc::new();
        let t = doc.get_or_insert_text("t");
        doc.transact_mut()
            .apply_update(Update::decode_v1(update).unwrap())
            .unwrap();
        let s = t.get_string(&doc.transact());
        s
    }

    #[test]
    fn append_then_load_survives_reopen() {
        let (dir, store, doc_id) = store_with_section();
        let editor = Doc::new();
        store
            .doc_append(&doc_id, &update_inserting(&editor, "lamp"))
            .unwrap();
        store
            .doc_append(&doc_id, &update_inserting(&editor, "light"))
            .unwrap();
        drop(store);
        let store = Store::open(dir.path()).unwrap();
        assert_eq!(text_of(&store.doc_diff(&doc_id, &[]).unwrap()), "lamplight");
    }

    #[test]
    fn diff_returns_only_unseen_changes() {
        let (_dir, store, doc_id) = store_with_section();
        let editor = Doc::new();
        store
            .doc_append(&doc_id, &update_inserting(&editor, "a"))
            .unwrap();
        // Someone else (e.g. the MCP server) writes to the stored doc.
        let other = Doc::new();
        other
            .transact_mut()
            .apply_update(Update::decode_v1(&store.doc_diff(&doc_id, &[]).unwrap()).unwrap())
            .unwrap();
        store
            .doc_append(&doc_id, &update_inserting(&other, "b"))
            .unwrap();
        let diff = store
            .doc_diff(&doc_id, &encode_state_vector(&editor))
            .unwrap();
        editor
            .transact_mut()
            .apply_update(Update::decode_v1(&diff).unwrap())
            .unwrap();
        let t = editor.get_or_insert_text("t");
        assert_eq!(t.get_string(&editor.transact()), "ab");
    }

    #[test]
    fn rejects_unknown_docs_and_garbage() {
        let (_dir, store, doc_id) = store_with_section();
        assert!(matches!(
            store.doc_append("nope", &update_inserting(&Doc::new(), "x")),
            Err(StorageError::NotFound(_))
        ));
        assert!(store.doc_append(&doc_id, &[0xff, 0x01, 0x02]).is_err());
        assert_eq!(store.doc_update_count(&doc_id).unwrap(), 0);
        assert!(store.doc_diff(&doc_id, &[0xff, 0xff]).is_err());
    }

    #[test]
    fn compaction_keeps_content() {
        let (_dir, store, doc_id) = store_with_section();
        let editor = Doc::new();
        for i in 0..COMPACT_AFTER {
            store
                .doc_append(&doc_id, &update_inserting(&editor, &(i % 10).to_string()))
                .unwrap();
        }
        assert_eq!(store.doc_update_count(&doc_id).unwrap(), 1);
        let text = text_of(&store.doc_diff(&doc_id, &[]).unwrap());
        assert_eq!(text.len(), COMPACT_AFTER as usize);
    }
}
