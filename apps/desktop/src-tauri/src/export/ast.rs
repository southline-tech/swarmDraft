//! Manuscript AST for export (#39): stored sections → accepted body without review marks.

use serde::Serialize;
use serde_json::{json, Value};

use crate::content::{self, Block};
use crate::manuscripts::{Manuscript, Section};
use crate::storage::{StorageError, Store};

const REVIEW_MARKS: &[&str] = &[
    "comment_anchor",
    "suggestion_insert",
    "suggestion_delete",
    "format_change",
];

/// Story-notes manuscripts (RAD-213) must never enter the book export pipeline.
pub fn is_book_manuscript(m: &Manuscript) -> bool {
    !m.id.starts_with("notes-")
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManuscriptAst {
    pub manuscript_id: String,
    pub title: String,
    pub author: Option<String>,
    pub sections: Vec<SectionAst>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionAst {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub position: i64,
    pub blocks: Vec<Value>,
}

pub fn build_manuscript_ast(
    store: &Store,
    manuscript_id: &str,
) -> Result<ManuscriptAst, StorageError> {
    let m = store.get_manuscript(manuscript_id)?;
    if !is_book_manuscript(&m) {
        return Err(StorageError::Invalid(
            "story-notes documents cannot be exported as a book".into(),
        ));
    }
    let mut sections = Vec::new();
    for s in store.list_sections(manuscript_id)? {
        let doc = store.load_doc(&s.doc_id)?;
        let blocks = content::decode_checked(&doc).map_err(StorageError::Invalid)?;
        sections.push(section_ast(&s, &blocks));
    }
    let author = infer_author(&sections);
    Ok(ManuscriptAst {
        manuscript_id: m.id,
        title: m.title,
        author,
        sections,
    })
}

fn infer_author(sections: &[SectionAst]) -> Option<String> {
    sections
        .iter()
        .find(|s| s.kind == "front_matter" && s.title == "Title Page")
        .and_then(|s| {
            for b in &s.blocks {
                if b["type"].as_str() != Some("paragraph") {
                    continue;
                }
                let text =
                    export_inline_text(b["content"].as_array().map(Vec::as_slice).unwrap_or(&[]));
                let t = text.trim();
                if t.is_empty() {
                    continue;
                }
                if t.to_ascii_lowercase().starts_with("by ") {
                    return Some(t[3..].trim().to_string());
                }
                if !t.contains('@')
                    && t.len() <= 80
                    && !t.eq_ignore_ascii_case("a novel")
                    && !t
                        .chars()
                        .all(|c| c.is_ascii_uppercase() || !c.is_alphabetic())
                {
                    return Some(t.to_string());
                }
            }
            None
        })
}

fn section_ast(section: &Section, blocks: &[Block]) -> SectionAst {
    SectionAst {
        id: section.id.clone(),
        kind: section.kind.clone(),
        title: section.title.clone(),
        position: section.position,
        blocks: blocks
            .iter()
            .map(|b| strip_block_for_export(&b.node))
            .filter(|n| !block_is_empty(n))
            .collect(),
    }
}

fn block_is_empty(node: &Value) -> bool {
    match node["type"].as_str() {
        Some("paragraph" | "heading") => {
            let content = node["content"].as_array();
            content.map(|c| c.is_empty()).unwrap_or(true)
                || export_inline_text(content.unwrap_or(&Vec::new())).is_empty()
        }
        Some("page_break") => false,
        Some("scene_break") => false,
        _ => true,
    }
}

fn export_inline_text(nodes: &[Value]) -> String {
    let mut s = String::new();
    for n in nodes {
        if n["type"].as_str() == Some("text") && !has_review_mark(n, "suggestion_insert") {
            s.push_str(n["text"].as_str().unwrap_or_default());
        } else if n["type"].as_str() == Some("hard_break") {
            s.push('\n');
        } else if n["type"].as_str() == Some("footnote") {
            s.push('†');
        } else if n["type"].as_str() == Some("image") {
            s.push('□');
        }
    }
    s.trim().to_string()
}

fn has_review_mark(node: &Value, ty: &str) -> bool {
    node["marks"]
        .as_array()
        .map(|marks| marks.iter().any(|m| m["type"].as_str() == Some(ty)))
        .unwrap_or(false)
}

fn strip_marks(marks: &[Value]) -> Vec<Value> {
    marks
        .iter()
        .filter(|m| {
            m["type"]
                .as_str()
                .is_some_and(|t| !REVIEW_MARKS.contains(&t))
        })
        .cloned()
        .collect()
}

fn strip_inline(nodes: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    for n in nodes {
        match n["type"].as_str() {
            Some("text") if has_review_mark(n, "suggestion_insert") => {}
            Some("text") => {
                let marks = strip_marks(n["marks"].as_array().map(Vec::as_slice).unwrap_or(&[]));
                let text = n["text"].as_str().unwrap_or_default();
                if text.is_empty() {
                    continue;
                }
                let mut node = json!({ "type": "text", "text": text });
                if !marks.is_empty() {
                    node["marks"] = Value::Array(marks);
                }
                out.push(node);
            }
            Some("hard_break") | Some("footnote") | Some("image") => out.push(n.clone()),
            _ => {}
        }
    }
    out
}

pub fn strip_block_for_export(node: &Value) -> Value {
    let ty = node["type"].as_str().unwrap_or("paragraph");
    match ty {
        "scene_break" | "page_break" => node.clone(),
        "heading" => {
            let mut n = node.clone();
            if let Some(content) = node["content"].as_array() {
                n["content"] = Value::Array(strip_inline(content));
            }
            n
        }
        _ => {
            let mut n = node.clone();
            if let Some(content) = node["content"].as_array() {
                n["content"] = Value::Array(strip_inline(content));
            }
            n
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manuscripts::new_id;

    #[test]
    fn strips_suggestion_marks_and_pending_inserts() {
        let node = json!({
            "type": "paragraph",
            "attrs": { "style": "body" },
            "content": [
                { "type": "text", "text": "Hello " },
                { "type": "text", "text": "bot", "marks": [{ "type": "suggestion_insert", "attrs": { "id": "1", "author": "a", "ts": "t" } }] },
                { "type": "text", "text": " world", "marks": [{ "type": "comment_anchor", "attrs": { "id": "c1" } }] }
            ]
        });
        let out = strip_block_for_export(&node);
        let text: String = out["content"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|n| n["text"].as_str())
            .collect();
        assert_eq!(text, "Hello  world");
        assert!(out["content"][1]["marks"].as_array().is_none());
    }

    #[test]
    fn build_ast_from_stored_section() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let m = store.create_manuscript("Export Me").unwrap();
        store
            .import_section_json(
                &m.id,
                "chapter",
                "One",
                &json!({"type":"doc","content":[{"type":"paragraph","attrs":{"style":"body"},"content":[{"type":"text","text":"Line."}]}]}),
            )
            .unwrap();
        let ast = build_manuscript_ast(&store, &m.id).unwrap();
        assert_eq!(ast.title, "Export Me");
        assert_eq!(ast.sections.len(), 1);
        assert_eq!(ast.sections[0].blocks.len(), 1);
    }

    #[test]
    fn rejects_story_notes_manuscript_id_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let id = format!("notes-{}", new_id());
        store
            .with_conn(|c| {
                c.execute(
                    "INSERT INTO manuscripts (id, title, created_at, numbering_style) VALUES (?1, ?2, datetime('now'), 'chapter_arabic')",
                    rusqlite::params![id, "Notes"],
                )?;
                Ok(())
            })
            .unwrap();
        let err = build_manuscript_ast(&store, &id).unwrap_err();
        assert!(err.to_string().contains("story-notes"));
    }
}
