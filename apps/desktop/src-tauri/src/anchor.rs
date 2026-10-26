//! Anchors for agent comments and suggestions (RAD-210): a block id plus an exact quote,
//! resolved against the current Yjs document at write time.
//!
//! The quote is matched against the block's visible text (pending suggested inserts are not
//! part of it, the same text `search_text` returns). Zero matches means the anchor is stale;
//! more than one means it is ambiguous. Both are errors the agent can act on.

use std::sync::Arc;

use yrs::types::text::YChange;
use yrs::types::xml::{XmlFragment, XmlOut};
use yrs::types::Attrs;
use yrs::{Any, Doc, Out, ReadTxn, Text, TransactionMut, XmlTextRef};

use crate::content::{block_id, FRAGMENT, NON_EXCLUSIVE_MARKS};

#[derive(Debug, PartialEq, Eq)]
pub enum AnchorError {
    BlockNotFound(String),
    EmptyQuote,
    Stale(String),
    Ambiguous(String, usize),
    OverlapsSuggestion,
}

impl std::fmt::Display for AnchorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BlockNotFound(b) => write!(f, "block {b} not found in this section (re-read it with read_chapter)"),
            Self::EmptyQuote => write!(f, "quote must not be empty"),
            Self::Stale(q) => write!(f, "stale anchor: {q:?} is not in that block any more (re-read it with read_chapter)"),
            Self::Ambiguous(q, n) => write!(f, "ambiguous anchor: {q:?} occurs {n} times in that block; quote more surrounding text"),
            Self::OverlapsSuggestion => write!(f, "the quoted text overlaps a pending suggestion; wait for the author to decide it"),
        }
    }
}

/// A resolved anchor: a range in one Y.XmlText, in the doc's offset units.
pub struct Range {
    pub text: XmlTextRef,
    pub start: u32,
    pub len: u32,
    /// The range touches text with a suggestion mark.
    pub overlaps_suggestion: bool,
    /// Formatting (non-overlapping marks) at the end of the range, for inserted text.
    pub formatting: Attrs,
}

fn collect_texts(txn: &TransactionMut, parent: &impl XmlFragment, out: &mut Vec<XmlTextRef>) {
    for c in parent.children(txn) {
        match c {
            XmlOut::Text(t) => out.push(t),
            XmlOut::Element(e) => collect_texts(txn, &e, out),
            XmlOut::Fragment(f) => collect_texts(txn, &f, out),
        }
    }
}

fn is_suggestion_key(k: &str) -> bool {
    k.starts_with("suggestion_insert--") || k.starts_with("suggestion_delete--")
}

fn units(doc: &Doc, s: &str) -> u32 {
    match doc.offset_kind() {
        yrs::OffsetKind::Bytes => s.len() as u32,
        yrs::OffsetKind::Utf16 => s.encode_utf16().count() as u32,
    }
}

/// Resolve `quote` inside block `block`.
pub fn resolve(
    doc: &Doc,
    txn: &TransactionMut,
    block: &str,
    quote: &str,
) -> Result<Range, AnchorError> {
    if quote.is_empty() {
        return Err(AnchorError::EmptyQuote);
    }
    let frag = txn
        .get_xml_fragment(FRAGMENT)
        .ok_or_else(|| AnchorError::BlockNotFound(block.into()))?;
    let el = frag
        .children(txn)
        .find_map(|c| match c {
            XmlOut::Element(e)
                if block_id(AsRef::<yrs::branch::Branch>::as_ref(&e).id()) == block =>
            {
                Some(e)
            }
            _ => None,
        })
        .ok_or_else(|| AnchorError::BlockNotFound(block.into()))?;
    let mut texts = Vec::new();
    collect_texts(txn, &el, &mut texts);

    let mut found: Vec<Range> = Vec::new();
    for t in texts {
        // Visible text, with each visible char's (unit offset, unit len, attrs) in the full text.
        let mut visible = String::new();
        let mut map: Vec<(u32, u32, Option<Box<Attrs>>)> = Vec::new();
        let mut pos = 0u32;
        for d in t.diff(txn, YChange::identity) {
            let Out::Any(Any::String(s)) = &d.insert else {
                pos += 1;
                continue;
            };
            let pending = d
                .attributes
                .as_ref()
                .is_some_and(|a| a.keys().any(|k| k.starts_with("suggestion_insert--")));
            for ch in s.chars() {
                let mut buf = [0u8; 4];
                let n = units(doc, ch.encode_utf8(&mut buf));
                if !pending {
                    visible.push(ch);
                    map.push((pos, n, d.attributes.clone()));
                }
                pos += n;
            }
        }
        let chars: Vec<char> = visible.chars().collect();
        let q: Vec<char> = quote.chars().collect();
        let mut i = 0;
        while i + q.len() <= chars.len() {
            if chars[i..i + q.len()] == q[..] {
                let first = &map[i];
                let last = &map[i + q.len() - 1];
                let start = first.0;
                let end = last.0 + last.1;
                // Pending inserts inside the range show up as gaps in the visible mapping.
                let gaps = (i..i + q.len() - 1).any(|k| map[k].0 + map[k].1 != map[k + 1].0);
                let marked = map[i..i + q.len()].iter().any(|m| {
                    m.2.as_ref()
                        .is_some_and(|a| a.keys().any(|k| is_suggestion_key(k)))
                });
                let formatting: Attrs = last
                    .2
                    .as_ref()
                    .map(|a| {
                        a.iter()
                            .filter(|(k, _)| {
                                !NON_EXCLUSIVE_MARKS
                                    .iter()
                                    .any(|m| k.starts_with(&format!("{m}--")))
                            })
                            .map(|(k, v)| (k.clone(), v.clone()))
                            .collect()
                    })
                    .unwrap_or_default();
                found.push(Range {
                    text: t.clone(),
                    start,
                    len: end - start,
                    overlaps_suggestion: gaps || marked,
                    formatting,
                });
                i += q.len();
            } else {
                i += 1;
            }
        }
    }
    match found.len() {
        0 => Err(AnchorError::Stale(quote.into())),
        1 => Ok(found.pop().unwrap()),
        n => Err(AnchorError::Ambiguous(quote.into(), n)),
    }
}

fn attrs1(key: String, value: serde_json::Value) -> Attrs {
    let mut a = Attrs::new();
    a.insert(
        Arc::from(key),
        serde_json::from_value(value).unwrap_or(Any::Null),
    );
    a
}

/// Mark the range with a comment anchor.
pub fn add_comment_mark(txn: &mut TransactionMut, r: &Range, comment_id: &str) {
    let a = attrs1(
        format!("comment_anchor--{comment_id}"),
        serde_json::json!({ "id": comment_id }),
    );
    r.text.format(txn, r.start, r.len, a);
}

/// Tracked replacement: mark the range as a suggested delete and insert `replacement` right
/// after it as a suggested insert. Nothing is applied until the author accepts.
pub fn add_suggestion_marks(
    txn: &mut TransactionMut,
    r: &Range,
    id: &str,
    author: &str,
    ts: &str,
    replacement: &str,
) {
    let meta = serde_json::json!({ "id": id, "author": author, "ts": ts });
    if r.len > 0 {
        r.text.format(
            txn,
            r.start,
            r.len,
            attrs1(format!("suggestion_delete--{id}"), meta.clone()),
        );
    }
    if !replacement.is_empty() {
        let mut a = r.formatting.clone();
        a.extend(attrs1(format!("suggestion_insert--{id}"), meta));
        r.text
            .insert_with_attributes(txn, r.start + r.len, replacement, a);
    }
}

/// Paragraph style of a block, if it is a paragraph.
pub fn block_kind(txn: &TransactionMut, block: &str) -> Option<String> {
    let frag = txn.get_xml_fragment(FRAGMENT)?;
    frag.children(txn).find_map(|c| match c {
        XmlOut::Element(e) if block_id(AsRef::<yrs::branch::Branch>::as_ref(&e).id()) == block => {
            Some(e.tag().to_string())
        }
        _ => None,
    })
}
