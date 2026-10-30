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

/// The one way to create a section document: UTF-16 offsets, like Yjs in JS and y-prosemirror.
/// (yrs defaults to UTF-8 bytes, which shifts mark ranges after any non-ASCII text.)
/// `Doc::new`, `Doc::with_client_id` and `Doc::with_options` are banned by clippy.toml; clippy can't target the
/// `Default` impl, so tests/utf16_docs.rs scans the sources for `Doc::default` and friends.
#[allow(clippy::disallowed_methods)] // the one sanctioned constructor
pub fn new_doc() -> Doc {
    Doc::with_options(yrs::Options {
        offset_kind: yrs::OffsetKind::Utf16,
        ..Default::default()
    })
}

/// Marks that may overlap with another mark of the same type; keyed `type--hash` in Yjs.
pub const NON_EXCLUSIVE_MARKS: &[&str] = &[
    "comment_anchor",
    "suggestion_insert",
    "suggestion_delete",
    "format_change",
];
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
    "format_change",
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

/// Node and mark types the schema knows (`BLOCK_NODE_TYPES`, `INLINE_NODE_TYPES`, `MARK_TYPES`
/// in `@coauthor/schema`).
pub const BLOCK_NODE_TYPES: &[&str] = &["paragraph", "heading", "scene_break", "page_break"];
pub const INLINE_NODE_TYPES: &[&str] = &["text", "hard_break", "footnote", "image"];

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// `markIdHash` in `@coauthor/schema` marks.ts: 64-bit FNV-1a over the UTF-8 bytes, low 48
/// bits big-endian as 8 standard base64 chars (y-prosemirror's `--[a-zA-Z0-9+/=]{8}` suffix).
pub fn mark_id_hash(s: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h = (h ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3);
    }
    (0..8)
        .map(|i| B64[((h >> (42 - 6 * i)) & 63) as usize] as char)
        .collect()
}

fn overlap_id(mark: &Value) -> Option<String> {
    let ty = mark["type"].as_str().unwrap_or_default();
    if !NON_EXCLUSIVE_MARKS.contains(&ty) {
        return None;
    }
    match &mark["attrs"]["id"] {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Yjs attribute key for one mark, ignoring collisions (`markKey`; use [`mark_keys`] for a
/// run's full mark set).
pub fn mark_key(mark: &Value) -> String {
    let ty = mark["type"].as_str().unwrap_or_default();
    match overlap_id(mark) {
        Some(id) => format!("{ty}--{}", mark_id_hash(&id)),
        None => ty.to_string(),
    }
}

/// Collision rehash attempts per mark before giving up (`MAX_MARK_KEY_TRIES` in marks.ts).
pub const MAX_MARK_KEY_TRIES: u32 = 1000;

/// Keys for all marks on one text run, unique within the run (`markKeys`): marks are taken in
/// (id, position) order and on a collision the mark is rehashed as `hash(id + ':' + n)` for
/// n = 1, 2, ... until free, erroring after [`MAX_MARK_KEY_TRIES`].
///
/// Keys are write-side only. Readers take the mark type from the key prefix and the id from
/// the attrs, never from the suffix: the editor binding re-keys marks with its own hash.
pub fn mark_keys(marks: &[Value]) -> Result<Vec<String>, String> {
    mark_keys_with(marks, mark_id_hash)
}

pub fn mark_keys_with(
    marks: &[Value],
    hash: impl Fn(&str) -> String,
) -> Result<Vec<String>, String> {
    let mut order: Vec<(usize, String)> = marks
        .iter()
        .enumerate()
        .map(|(i, m)| (i, overlap_id(m).unwrap_or_default()))
        .collect();
    order.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(&b.0)));
    let mut used = std::collections::HashSet::new();
    let mut keys = vec![String::new(); marks.len()];
    for (i, id) in order {
        let ty = marks[i]["type"].as_str().unwrap_or_default();
        let mut key = if id.is_empty() {
            ty.to_string()
        } else {
            format!("{ty}--{}", hash(&id))
        };
        let mut n = 1;
        while !id.is_empty() && used.contains(&key) {
            if n > MAX_MARK_KEY_TRIES {
                return Err(format!(
                    "no free key for {ty} mark {id:?} after {MAX_MARK_KEY_TRIES} tries"
                ));
            }
            key = format!("{ty}--{}", hash(&format!("{id}:{n}")));
            n += 1;
        }
        used.insert(key.clone());
        keys[i] = key;
    }
    Ok(keys)
}

/// Reject any node or mark type the schema doesn't know. Every MCP write is checked with this
/// before it touches a document, so an agent can never store content the editor would drop.
pub fn validate_nodes(nodes: &[Value], inline: bool) -> Result<(), String> {
    for n in nodes {
        let ty = n["type"].as_str().ok_or("node without a type")?;
        let ok = if inline {
            INLINE_NODE_TYPES.contains(&ty)
        } else {
            BLOCK_NODE_TYPES.contains(&ty)
        };
        if !ok {
            return Err(format!("unknown node type: {ty}"));
        }
        for m in n["marks"].as_array().into_iter().flatten() {
            let mt = m["type"].as_str().ok_or("mark without a type")?;
            if !MARK_ORDER.contains(&mt) {
                return Err(format!("unknown mark type: {mt}"));
            }
        }
        if let Some(c) = n["content"].as_array() {
            // Footnotes hold blocks; every other container holds inline content.
            validate_nodes(c, ty != "footnote")?;
        }
    }
    Ok(())
}

/// [`validate_nodes`] for a whole ProseMirror `doc`.
pub fn validate_doc(pm_doc: &Value) -> Result<(), String> {
    if pm_doc["type"] != "doc" {
        return Err("expected a doc node".into());
    }
    validate_nodes(
        pm_doc["content"].as_array().map_or(&[][..], Vec::as_slice),
        false,
    )
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

/// [`decode`], erroring if the section holds a node or mark type the schema doesn't know
/// (reads report it rather than silently dropping content).
pub fn decode_checked(doc: &Doc) -> Result<Vec<Block>, String> {
    let blocks = decode(doc);
    let nodes: Vec<Value> = blocks.iter().map(|b| b.node.clone()).collect();
    validate_nodes(&nodes, false)
        .map_err(|e| format!("section holds content outside the schema ({e})"))?;
    Ok(blocks)
}

fn fill(
    txn: &mut TransactionMut,
    parent: &impl XmlFragment,
    nodes: &[Value],
) -> Result<(), String> {
    let mut i = 0;
    while i < nodes.len() {
        if nodes[i]["type"] == "text" {
            let t = parent.push_back(txn, yrs::XmlTextPrelim::new(""));
            let mut offset = 0u32;
            while i < nodes.len() && nodes[i]["type"] == "text" {
                let n = &nodes[i];
                let s = n["text"].as_str().unwrap_or_default();
                let mut attrs = Attrs::new();
                let marks = n["marks"].as_array().map_or(&[][..], Vec::as_slice);
                for (m, key) in marks.iter().zip(mark_keys(marks)?) {
                    let a = m.get("attrs").cloned().unwrap_or_else(|| json!({}));
                    attrs.insert(key.into(), json_to_any(&a));
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
            fill(txn, &el, c)?;
        }
        i += 1;
    }
    Ok(())
}

/// Append the blocks of a ProseMirror `doc` JSON to a section document (same encoding as
/// `docToYDoc` in ydoc.ts). Errors only if a run's mark keys can't be made unique.
pub fn encode(doc: &Doc, pm_doc: &Value) -> Result<(), String> {
    let frag: XmlFragmentRef = doc.get_or_insert_xml_fragment(FRAGMENT);
    let mut txn = doc.transact_mut();
    if let Some(c) = pm_doc["content"].as_array() {
        fill(&mut txn, &frag, c)?;
    }
    Ok(())
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
        let doc = new_doc();
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
        let doc = new_doc();
        encode(&doc, &expected["doc"]).unwrap();
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

    /// Shared with marks.ts via fixtures/marks/mark-id-hash-vectors.json (mark-vectors.test.ts).
    #[test]
    fn mark_keys_match_shared_cross_language_vectors() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../fixtures/marks/mark-id-hash-vectors.json");
        let v: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let hashes = v["hash"].as_array().unwrap();
        assert!(hashes
            .iter()
            .any(|h| h["input"] == "c1" && h["hash"] == "fwe1SmhZ"));
        for h in hashes {
            let input = h["input"].as_str().unwrap();
            assert_eq!(
                mark_id_hash(input),
                h["hash"].as_str().unwrap(),
                "{input:?}"
            );
        }
        let cases = v["keys"].as_array().unwrap();
        assert!(cases.len() >= 5);
        for c in cases {
            let marks = c["marks"].as_array().unwrap();
            let want: Vec<String> = serde_json::from_value(c["keys"].clone()).unwrap();
            assert_eq!(mark_keys(marks).unwrap(), want, "{}", c["name"]);
        }
    }

    #[test]
    fn exclusive_marks_key_by_type_only() {
        let link = json!({"type":"link","attrs":{"href":"x","id":"c1"}});
        assert_eq!(mark_key(&link), "link");
        assert_eq!(
            mark_keys(&[json!({"type":"bold"}), link]).unwrap(),
            ["bold", "link"]
        );
    }

    #[test]
    fn collision_loop_is_capped() {
        let a = json!({"type":"comment_anchor","attrs":{"id":"a"}});
        let err = mark_keys_with(&[a.clone(), a], |_| "AAAAAAAA".into()).unwrap_err();
        assert!(err.contains("after 1000 tries"), "{err}");
    }

    #[test]
    fn rekeyed_marks_are_read_by_attrs_id() {
        // The editor binding re-keys marks with its own hash on edit (fwe1SmhZ -> Ql7mhpA0).
        let doc = new_doc();
        {
            let frag = doc.get_or_insert_xml_fragment(FRAGMENT);
            let mut txn = doc.transact_mut();
            let p = frag.push_back(&mut txn, yrs::XmlElementPrelim::empty("paragraph"));
            let t = p.push_back(&mut txn, yrs::XmlTextPrelim::new(""));
            let mut attrs = Attrs::new();
            attrs.insert(
                "comment_anchor--Ql7mhpA0".into(),
                json_to_any(&json!({"id":"c1"})),
            );
            attrs.insert(
                "suggestion_insert--zzzzzzzz".into(),
                json_to_any(&json!({"id":"s9","author":"agent:x","ts":"t"})),
            );
            t.insert_with_attributes(&mut txn, 0, "lantern", attrs);
        }
        let blocks = decode(&doc);
        let marks = blocks[0].node["content"][0]["marks"].as_array().unwrap();
        assert_eq!(marks[0]["type"], "comment_anchor");
        assert_eq!(marks[0]["attrs"]["id"], "c1");
        assert_eq!(marks[1]["type"], "suggestion_insert");
        assert_eq!(marks[1]["attrs"]["id"], "s9");
        let md = markdown(&blocks);
        assert!(md.contains("c1") && md.contains("s9"), "{md}");
    }

    #[test]
    fn reads_report_unknown_types_instead_of_dropping_them() {
        let doc = new_doc();
        {
            let frag = doc.get_or_insert_xml_fragment(FRAGMENT);
            let mut txn = doc.transact_mut();
            let p = frag.push_back(&mut txn, yrs::XmlElementPrelim::empty("paragraph"));
            let t = p.push_back(&mut txn, yrs::XmlTextPrelim::new(""));
            let mut attrs = Attrs::new();
            attrs.insert("highlight".into(), json_to_any(&json!({})));
            t.insert_with_attributes(&mut txn, 0, "lantern", attrs);
            frag.push_back(&mut txn, yrs::XmlElementPrelim::empty("table"));
        }
        let err = decode_checked(&doc).unwrap_err();
        assert!(err.contains("highlight"), "{err}");
        let ok = new_doc();
        encode(&ok, &json!({"type":"doc","content":[{"type":"paragraph"}]})).unwrap();
        assert_eq!(decode_checked(&ok).unwrap().len(), 1);
    }

    /// The validator's lists are the schema's (exported by mcp-fixture.test.ts).
    #[test]
    fn allowed_types_match_coauthor_schema() {
        let f: Value = serde_json::from_str(
            &std::fs::read_to_string(fixture("synthetic-section.json")).unwrap(),
        )
        .unwrap();
        let list =
            |k: &str| -> Vec<String> { serde_json::from_value(f["schema"][k].clone()).unwrap() };
        assert_eq!(list("blockNodes"), BLOCK_NODE_TYPES);
        assert_eq!(list("inlineNodes"), INLINE_NODE_TYPES);
        assert_eq!(list("marks"), MARK_ORDER);
        assert_eq!(list("nonExclusiveMarks"), NON_EXCLUSIVE_MARKS);
    }

    #[test]
    fn validation_rejects_unknown_nodes_and_marks() {
        let ok = json!({"type":"doc","content":[{"type":"paragraph","content":[
            {"type":"text","text":"a","marks":[{"type":"bold"},{"type":"comment_anchor","attrs":{"id":"c1"}}]},
            {"type":"footnote","content":[{"type":"paragraph","content":[{"type":"text","text":"n"}]}]}
        ]}]});
        assert_eq!(validate_doc(&ok), Ok(()));
        let fx: Value = serde_json::from_str(
            &std::fs::read_to_string(fixture("synthetic-section.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            validate_doc(&fx["doc"]),
            Ok(()),
            "fixture uses only schema types"
        );
        let bad_mark = json!({"type":"doc","content":[{"type":"paragraph","content":[
            {"type":"text","text":"a","marks":[{"type":"highlight"}]}]}]});
        assert!(validate_doc(&bad_mark).unwrap_err().contains("highlight"));
        let bad_node = json!({"type":"doc","content":[{"type":"table"}]});
        assert!(validate_doc(&bad_node).unwrap_err().contains("table"));
        let inline_as_block = json!({"type":"doc","content":[{"type":"text","text":"x"}]});
        assert!(validate_doc(&inline_as_block).is_err());
    }

    #[test]
    fn block_ids_are_stable_across_edits() {
        use yrs::updates::encoder::Encode;
        let doc = load_ts_fixture();
        let before: Vec<String> = decode(&doc).into_iter().map(|b| b.id).collect();
        // Another replica inserts a block at the front and edits text; sync it back.
        let other = new_doc();
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
        assert!(after[0].starts_with(&format!("b{}.", other.client_id())));
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
}
