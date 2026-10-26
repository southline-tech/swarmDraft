//! Section content in Rust (RAD-209): Yjs (y-prosemirror encoding) <-> ProseMirror JSON, the
//! agent read view, and markdown/json renderings for the MCP read tools.
//!
//! Mirrors `@coauthor/schema` `content.ts` and `readView()` in `packages/docx/src/model.ts`.
//! `fixtures/mcp/` holds a section encoded by the TypeScript code; tests on both sides check that
//! they agree (see `fixtures/mcp/README.md`).
//!
//! Block ids are the Yjs item ids of the block elements (`b<client>.<clock>`). They are assigned
//! when a block is created, never change, survive concurrent edits elsewhere in the section, and
//! need no extra attribute in the document schema.

use serde::Serialize;
use serde_json::{json, Map, Value};
use yrs::types::text::YChange;
use yrs::types::xml::{Xml, XmlFragment, XmlOut};
use yrs::types::Attrs;
use yrs::{
    Any, BranchID, Doc, GetString, Out, ReadTxn, Text, Transact, TransactionMut, XmlFragmentRef,
};

/// Name of the Y.XmlFragment that holds a section (same as y-prosemirror / `FRAGMENT_NAME`).
pub const FRAGMENT: &str = "prosemirror";

/// Marks that may overlap with another mark of the same type; keyed `type--hash` in Yjs.
pub const NON_EXCLUSIVE_MARKS: &[&str] =
    &["comment_anchor", "suggestion_insert", "suggestion_delete"];
const MARK_ORDER: &[&str] = &[
    "bold",
    "italic",
    "smallcaps",
    "underline",
    "strike",
    "link",
    "comment_anchor",
    "suggestion_insert",
    "suggestion_delete",
];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Block {
    pub id: String,
    /// ProseMirror JSON of the block (`paragraph`, `heading`, `scene_break`, `page_break`).
    pub node: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Note {
    pub id: String,
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReadView {
    pub text: String,
    pub footnotes: Vec<Note>,
}

/// FNV-1a over the JSON of a mark's attrs, base36 (same as `hashAttrs` in ydoc.ts).
/// Yjs attribute key for a mark (`markKey` in ydoc.ts).
pub fn mark_key(mark: &Value) -> String {
    let ty = mark["type"].as_str().unwrap_or_default();
    match mark.get("attrs") {
        // `type--<8 hex>`: y-prosemirror only parses an 8-char suffix as an overlap key.
        Some(a) if NON_EXCLUSIVE_MARKS.contains(&ty) && a.get("id").is_some() => {
            let id = a["id"]
                .as_str()
                .map_or_else(|| a["id"].to_string(), str::to_string);
            format!("{ty}--{}", mark_id_hash(&id))
        }
        _ => ty.to_string(),
    }
}

/// 32-bit FNV-1a of the id's UTF-8 bytes as 8 hex chars (`markIdHash` in ydoc.ts).
pub fn mark_id_hash(id: &str) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for b in id.bytes() {
        h = (h ^ u32::from(b)).wrapping_mul(0x0100_0193);
    }
    format!("{h:08x}")
}

fn mark_type_from_key(key: &str) -> &str {
    key.split_once("--").map_or(key, |(t, _)| t)
}

fn any_to_json(a: &Any) -> Value {
    serde_json::to_value(a).unwrap_or(Value::Null)
}

fn json_to_any(v: &Value) -> Any {
    serde_json::from_value(v.clone()).unwrap_or(Any::Null)
}

pub fn block_id(branch: BranchID) -> String {
    match branch {
        BranchID::Nested(id) => format!("b{}.{}", id.client, id.clock),
        BranchID::Root(name) => format!("root:{name}"),
    }
}

fn sort_marks(marks: &mut [Value]) {
    let rank = |m: &Value| {
        let t = m["type"].as_str().unwrap_or_default();
        MARK_ORDER
            .iter()
            .position(|x| *x == t)
            .unwrap_or(usize::MAX)
    };
    marks.sort_by(|a, b| {
        rank(a).cmp(&rank(b)).then_with(|| {
            let k = |m: &Value| m.get("attrs").map(|a| a.to_string()).unwrap_or_default();
            k(a).cmp(&k(b))
        })
    });
}

fn decode_children<T: ReadTxn>(txn: &T, parent: &impl XmlFragment) -> Vec<Value> {
    let mut out = Vec::new();
    for child in parent.children(txn) {
        match child {
            XmlOut::Text(t) => {
                for d in t.diff(txn, YChange::identity) {
                    let text = match &d.insert {
                        Out::Any(Any::String(s)) => s.to_string(),
                        _ => continue,
                    };
                    let mut node = json!({ "type": "text", "text": text });
                    if let Some(attrs) = d.attributes {
                        let mut marks: Vec<Value> = attrs
                            .iter()
                            .filter(|(_, v)| !matches!(v, Any::Null))
                            .map(|(k, v)| {
                                let ty = mark_type_from_key(k);
                                let a = any_to_json(v);
                                if a.as_object().is_some_and(|o| !o.is_empty()) {
                                    json!({ "type": ty, "attrs": a })
                                } else {
                                    json!({ "type": ty })
                                }
                            })
                            .collect();
                        if !marks.is_empty() {
                            sort_marks(&mut marks);
                            node["marks"] = Value::Array(marks);
                        }
                    }
                    out.push(node);
                }
            }
            XmlOut::Element(e) => out.push(decode_element(txn, &e)),
            XmlOut::Fragment(f) => out.extend(decode_children(txn, &f)),
        }
    }
    out
}

fn decode_element<T: ReadTxn>(txn: &T, e: &yrs::XmlElementRef) -> Value {
    let mut node = Map::new();
    node.insert("type".into(), Value::String(e.tag().to_string()));
    let mut attrs: Vec<(String, Value)> = e
        .attributes(txn)
        .map(|(k, v)| (k.to_string(), out_to_json(&v)))
        .collect();
    if !attrs.is_empty() {
        attrs.sort_by(|a, b| a.0.cmp(&b.0));
        node.insert("attrs".into(), Value::Object(attrs.into_iter().collect()));
    }
    let content = decode_children(txn, e);
    if !content.is_empty() {
        node.insert("content".into(), Value::Array(content));
    }
    Value::Object(node)
}

fn out_to_json(v: &Out) -> Value {
    match v {
        Out::Any(a) => any_to_json(a),
        other => Value::String(other.to_string()),
    }
}

/// Decode a section document into its blocks (with stable ids).
pub fn decode(doc: &Doc) -> Vec<Block> {
    let frag = doc.get_or_insert_xml_fragment(FRAGMENT);
    let txn = doc.transact();
    frag.children(&txn)
        .filter_map(|c| match c {
            XmlOut::Element(e) => Some(Block {
                id: block_id(AsRef::<yrs::branch::Branch>::as_ref(&e).id()),
                node: decode_element(&txn, &e),
            }),
            _ => None,
        })
        .collect()
}

fn fill(txn: &mut TransactionMut, parent: &impl XmlFragment, nodes: &[Value]) {
    let mut i = 0;
    while i < nodes.len() {
        if nodes[i]["type"] == "text" {
            let t = parent.push_back(txn, yrs::XmlTextPrelim::new(""));
            let mut offset = 0u32;
            while i < nodes.len() && nodes[i]["type"] == "text" {
                let n = &nodes[i];
                let s = n["text"].as_str().unwrap_or_default();
                let mut attrs = Attrs::new();
                for m in n["marks"].as_array().into_iter().flatten() {
                    let a = m.get("attrs").cloned().unwrap_or_else(|| json!({}));
                    attrs.insert(mark_key(m).into(), json_to_any(&a));
                }
                t.insert_with_attributes(txn, offset, s, attrs);
                offset += s.encode_utf16().count() as u32;
                i += 1;
            }
            continue;
        }
        let n = &nodes[i];
        let el = parent.push_back(
            txn,
            yrs::XmlElementPrelim::empty(n["type"].as_str().unwrap_or("paragraph")),
        );
        for (k, v) in n["attrs"].as_object().into_iter().flatten() {
            el.insert_attribute(txn, k.as_str(), json_to_any(v));
        }
        if let Some(c) = n["content"].as_array() {
            fill(txn, &el, c);
        }
        i += 1;
    }
}

/// Append the blocks of a ProseMirror `doc` JSON to a section document (same encoding as
/// `docToYDoc` in ydoc.ts).
pub fn encode(doc: &Doc, pm_doc: &Value) {
    let frag: XmlFragmentRef = doc.get_or_insert_xml_fragment(FRAGMENT);
    let mut txn = doc.transact_mut();
    if let Some(c) = pm_doc["content"].as_array() {
        fill(&mut txn, &frag, c);
    }
}

fn has_mark(node: &Value, ty: &str) -> bool {
    node["marks"]
        .as_array()
        .is_some_and(|ms| ms.iter().any(|m| m["type"] == ty))
}

/// One block as a line of the read view (`readView` in model.ts).
pub fn block_line(node: &Value, notes: &mut Vec<Note>) -> String {
    match node["type"].as_str() {
        Some("scene_break") => {
            let m = node["attrs"]["marker"].as_str().unwrap_or_default();
            if m.is_empty() {
                "* * *".into()
            } else {
                m.into()
            }
        }
        Some("page_break") => String::new(),
        _ => inline_line(
            node["content"].as_array().map(Vec::as_slice).unwrap_or(&[]),
            notes,
        ),
    }
}

fn inline_line(nodes: &[Value], notes: &mut Vec<Note>) -> String {
    let mut s = String::new();
    for n in nodes {
        match n["type"].as_str() {
            Some("text") => s.push_str(n["text"].as_str().unwrap_or_default()),
            Some("hard_break") => s.push('\n'),
            Some("image") => s.push_str(&format!(
                "[image: {}]",
                n["attrs"]["alt"].as_str().unwrap_or_default()
            )),
            Some("footnote") => {
                let a = &n["attrs"];
                let id = a["id"].as_str().unwrap_or_default().to_string();
                let kind = a["kind"].as_str().unwrap_or("footnote").to_string();
                s.push_str(&if kind == "endnote" {
                    format!("[^e{id}]")
                } else {
                    format!("[^{id}]")
                });
                notes.push(Note {
                    id,
                    kind,
                    text: a["text"].as_str().unwrap_or_default().into(),
                });
            }
            _ => {}
        }
    }
    s
}

pub fn read_view(blocks: &[Block]) -> ReadView {
    let mut footnotes = Vec::new();
    let lines: Vec<String> = blocks
        .iter()
        .map(|b| block_line(&b.node, &mut footnotes))
        .collect();
    ReadView {
        text: lines.join("\n"),
        footnotes,
    }
}

/// Plain text of a block as an author would read it: pending suggested deletions are kept,
/// pending insertions are left out (agents see suggestions separately). Used for search and
/// anchors.
pub fn block_text(node: &Value) -> String {
    let empty = Vec::new();
    let content = node["content"].as_array().unwrap_or(&empty);
    let mut s = String::new();
    for n in content {
        match n["type"].as_str() {
            Some("text") if !has_mark(n, "suggestion_insert") => {
                s.push_str(n["text"].as_str().unwrap_or_default())
            }
            Some("hard_break") => s.push('\n'),
            _ => {}
        }
    }
    s
}

fn md_escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for ch in s.chars() {
        if matches!(ch, '*' | '_' | '`' | '[' | ']' | '{' | '}' | '\\' | '<') {
            o.push('\\');
        }
        o.push(ch);
    }
    o
}

fn md_inline(nodes: &[Value]) -> String {
    let mut s = String::new();
    for n in nodes {
        match n["type"].as_str() {
            Some("text") => {
                let mut t = md_escape(n["text"].as_str().unwrap_or_default());
                let marks = n["marks"].as_array().cloned().unwrap_or_default();
                for m in &marks {
                    let id = m["attrs"]["id"].as_str().unwrap_or_default();
                    t = match m["type"].as_str().unwrap_or_default() {
                        "italic" => format!("*{t}*"),
                        "bold" => format!("**{t}**"),
                        "strike" => format!("~~{t}~~"),
                        "link" => {
                            format!("[{t}]({})", m["attrs"]["href"].as_str().unwrap_or_default())
                        }
                        "comment_anchor" => format!("{{=={t}==}}{{>>comment:{id}<<}}"),
                        "suggestion_insert" => format!("{{++{t}++}}{{>>suggestion:{id}<<}}"),
                        "suggestion_delete" => format!("{{--{t}--}}{{>>suggestion:{id}<<}}"),
                        _ => t,
                    };
                }
                s.push_str(&t);
            }
            Some("hard_break") => s.push_str("  \n"),
            Some("image") => s.push_str(&format!(
                "[image: {}]",
                md_escape(n["attrs"]["alt"].as_str().unwrap_or_default())
            )),
            Some("footnote") => {
                let a = &n["attrs"];
                let id = a["id"].as_str().unwrap_or_default();
                s.push_str(&if a["kind"] == "endnote" {
                    format!("[^e{id}]")
                } else {
                    format!("[^{id}]")
                });
            }
            _ => {}
        }
    }
    s
}

/// Markdown rendering. Each block is preceded by `<!-- block:<id> -->`; suggestions and comment
/// anchors use CriticMarkup with their ids; notes are listed at the end as `[^id]: text`.
pub fn markdown(blocks: &[Block]) -> String {
    let mut out = String::new();
    let mut notes = Vec::new();
    for b in blocks {
        let n = &b.node;
        let empty = Vec::new();
        let content = n["content"].as_array().unwrap_or(&empty);
        block_line(n, &mut notes);
        out.push_str(&format!("<!-- block:{} -->\n", b.id));
        let body = match n["type"].as_str() {
            Some("heading") => {
                let lvl = n["attrs"]["level"].as_u64().unwrap_or(1).clamp(1, 6) as usize;
                format!("{} {}", "#".repeat(lvl), md_inline(content))
            }
            Some("scene_break") => {
                let m = n["attrs"]["marker"].as_str().unwrap_or_default();
                if m.is_empty() {
                    "* * *".into()
                } else {
                    md_escape(m)
                }
            }
            Some("page_break") => "<!-- page break -->".into(),
            _ => {
                let t = md_inline(content);
                match n["attrs"]["style"].as_str() {
                    Some("block_quote") | Some("epigraph") => format!("> {t}"),
                    _ => t,
                }
            }
        };
        out.push_str(&body);
        out.push_str("\n\n");
    }
    for note in &notes {
        let id = if note.kind == "endnote" {
            format!("e{}", note.id)
        } else {
            note.id.clone()
        };
        out.push_str(&format!("[^{id}]: {}\n", md_escape(&note.text)));
    }
    out.trim_end().to_string() + "\n"
}

/// Word count of the read view (whitespace-separated tokens).
pub fn word_count(blocks: &[Block]) -> usize {
    blocks
        .iter()
        .map(|b| block_text(&b.node).split_whitespace().count())
        .sum()
}

pub fn doc_text(doc: &Doc) -> String {
    let frag = doc.get_or_insert_xml_fragment(FRAGMENT);
    let txn = doc.transact();
    frag.get_string(&txn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::updates::decoder::Decode;
    use yrs::Update;

    fn fixture(name: &str) -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../fixtures/mcp")
            .join(name)
    }

    fn load_ts_fixture() -> Doc {
        let bytes = std::fs::read(fixture("synthetic-section.yupdate")).unwrap();
        let doc = Doc::new();
        doc.transact_mut()
            .apply_update(Update::decode_v1(&bytes).unwrap())
            .unwrap();
        doc
    }

    #[test]
    fn decodes_typescript_encoded_section() {
        let doc = load_ts_fixture();
        let blocks = decode(&doc);
        let expected: Value = serde_json::from_str(
            &std::fs::read_to_string(fixture("synthetic-section.json")).unwrap(),
        )
        .unwrap();
        let got = Value::Array(blocks.iter().map(|b| b.node.clone()).collect());
        assert_eq!(
            got, expected["doc"]["content"],
            "Rust decode must equal the TS source doc"
        );
        let view = read_view(&blocks);
        assert_eq!(serde_json::to_value(&view).unwrap(), expected["readView"]);
        // Block ids are the TS client's item ids, so they are identical on every load.
        assert_eq!(
            decode(&load_ts_fixture())
                .iter()
                .map(|b| &b.id)
                .collect::<Vec<_>>(),
            blocks.iter().map(|b| &b.id).collect::<Vec<_>>()
        );
        assert!(blocks.iter().all(|b| b.id.starts_with("b1.")));
    }

    #[test]
    fn rust_encode_roundtrips_and_matches_mark_keys() {
        let expected: Value = serde_json::from_str(
            &std::fs::read_to_string(fixture("synthetic-section.json")).unwrap(),
        )
        .unwrap();
        let doc = Doc::new();
        encode(&doc, &expected["doc"]);
        let blocks = decode(&doc);
        let got = Value::Array(blocks.iter().map(|b| b.node.clone()).collect());
        assert_eq!(got, expected["doc"]["content"]);
        // Same Yjs attribute keys as the TS encoder.
        for (m, key) in expected["markKeys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| (&p[0], &p[1]))
        {
            assert_eq!(&Value::String(mark_key(m)), key);
        }
    }

    #[test]
    fn block_ids_are_stable_across_edits() {
        use yrs::updates::encoder::Encode;
        let doc = load_ts_fixture();
        let before: Vec<String> = decode(&doc).into_iter().map(|b| b.id).collect();
        // Another replica inserts a block at the front and edits text; sync it back.
        let other = Doc::with_client_id(99);
        let full = doc
            .transact()
            .encode_state_as_update_v1(&yrs::StateVector::default());
        other
            .transact_mut()
            .apply_update(Update::decode_v1(&full).unwrap())
            .unwrap();
        {
            let frag = other.get_or_insert_xml_fragment(FRAGMENT);
            let mut txn = other.transact_mut();
            frag.insert(&mut txn, 0, yrs::XmlElementPrelim::empty("paragraph"));
        }
        let sv = doc.transact().state_vector();
        let diff = other.transact().encode_state_as_update_v1(&sv);
        doc.transact_mut()
            .apply_update(Update::decode_v1(&diff).unwrap())
            .unwrap();
        let after: Vec<String> = decode(&doc).into_iter().map(|b| b.id).collect();
        assert_eq!(after.len(), before.len() + 1);
        assert!(after[0].starts_with("b99."));
        assert_eq!(&after[1..], &before[..]);
        let _ = sv.encode_v1();
    }

    #[test]
    fn markdown_has_block_ids_suggestions_and_notes() {
        let doc = load_ts_fixture();
        let md = markdown(&decode(&doc));
        assert!(md.starts_with("<!-- block:b1."));
        assert!(md.contains("{++"), "{md}");
        assert!(md.contains("[^"), "{md}");
    }

    #[test]
    fn mark_id_hash_matches_ts() {
        assert_eq!(super::mark_id_hash("c1"), "8829dfd9");
    }
}
