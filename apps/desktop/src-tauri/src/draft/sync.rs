//! Serialize SQLite / Yjs state into the on-disk git working tree.

use std::fs;
use std::path::Path;

use serde_json::json;
use yrs::{Doc, ReadTxn, StateVector, Transact};

use crate::agent_access::{ACCESS_MODE_ALL, ACCESS_MODE_SELECTED};
use crate::content::{self, decode};
use crate::notes;
use crate::storage::{StorageError, Store};

use super::repo::DraftRepoError;

pub fn sync_store_to_worktree(
    store: &Store,
    manuscript_id: &str,
    worktree: &Path,
) -> Result<(), DraftRepoError> {
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

    for section in &sections {
        if section.kind != "chapter" {
            continue;
        }
        let doc = store.load_doc(&section.doc_id).map_err(storage_err)?;
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
    Ok(())
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

fn storage_err(e: StorageError) -> DraftRepoError {
    DraftRepoError::Invalid(e.to_string())
}
