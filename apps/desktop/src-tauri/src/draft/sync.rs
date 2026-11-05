//! Bidirectional sync between SQLite / Yjs and the on-disk git working tree.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::Deserialize;
use serde_json::json;
use yrs::{Array, Doc, Map, MapPrelim, ReadTxn, StateVector, Transact};

use crate::agent_access::{ACCESS_MODE_ALL, ACCESS_MODE_SELECTED};
use crate::content::{self, decode};
use crate::manuscripts::{OutlineEntry, DEFAULT_NUMBERING_STYLE, SECTION_KINDS};
use crate::notes;
use crate::storage::{StorageError, Store};

use super::repo::DraftRepoError;

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
    Ok(())
}

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
