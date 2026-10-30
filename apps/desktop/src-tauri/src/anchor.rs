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
use yrs::{Any, Doc, Out, ReadTxn, Text, TransactionMut, Xml, XmlTextRef};

use crate::content::{block_id, mark_id_hash, FRAGMENT, NON_EXCLUSIVE_MARKS};

#[derive(Debug, PartialEq, Eq)]
pub enum AnchorError {
    BlockNotFound(String),
    EmptyQuote,
    Stale(String),
    Ambiguous(String, usize),
    OverlapsSuggestion,
    SpansFootnote(String),
    NoMarkableText,
}

impl std::fmt::Display for AnchorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BlockNotFound(b) => write!(f, "block {b} not found in this section (re-read it with read_chapter)"),
            Self::EmptyQuote => write!(f, "quote must not be empty"),
            Self::Stale(q) => write!(f, "stale anchor: {q:?} is not in that block any more (re-read it with read_chapter)"),
            Self::Ambiguous(q, n) => write!(f, "ambiguous anchor: {q:?} occurs {n} times in that block; quote more surrounding text"),
            Self::OverlapsSuggestion => write!(f, "the quoted text overlaps a pending suggestion; wait for the author to decide it"),
            Self::SpansFootnote(q) => write!(f, "quote {q:?} spans a footnote marker; quote text on one side of the footnote only"),
            Self::NoMarkableText => write!(f, "block has no text to mark with a format suggestion"),
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
    /// Yjs attribute keys already present anywhere in the range (to avoid key collisions).
    pub keys: std::collections::HashSet<String>,
}

/// Key for a new overlapping mark: `type--markIdHash(id)`, or on a collision with a key already
/// in the range, `type--markIdHash(id:n)` for the first free n (same rule as `mark_keys`).
fn free_key(ty: &str, id: &str, taken: &std::collections::HashSet<String>) -> String {
    let mut key = format!("{ty}--{}", mark_id_hash(id));
    let mut n = 1;
    while taken.contains(&key) {
        key = format!("{ty}--{}", mark_id_hash(&format!("{id}:{n}")));
        n += 1;
    }
    key
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

/// Visible text of the block's runs, joined across footnote markers (and only those). True when
/// the quote matches there but in no single run, i.e. it straddles a footnote.
fn spans_footnote(txn: &TransactionMut, el: &impl XmlFragment, quote: &str) -> bool {
    let mut runs = vec![String::new()];
    let mut crossed = vec![false];
    for c in el.children(txn) {
        match c {
            XmlOut::Text(t) => runs.last_mut().unwrap().push_str(&visible_text(txn, &t)),
            XmlOut::Element(e) if e.tag().as_ref() == "footnote" => {
                *crossed.last_mut().unwrap() = true;
            }
            _ => {
                runs.push(String::new());
                crossed.push(false);
            }
        }
    }
    runs.iter()
        .zip(crossed)
        .any(|(r, x)| x && r.contains(quote))
}

fn visible_text(txn: &TransactionMut, t: &XmlTextRef) -> String {
    let mut s = String::new();
    for d in t.diff(txn, YChange::identity) {
        let Out::Any(Any::String(x)) = &d.insert else {
            continue;
        };
        let pending = d
            .attributes
            .as_ref()
            .is_some_and(|a| a.keys().any(|k| k.starts_with("suggestion_insert--")));
        if !pending {
            s.push_str(x);
        }
    }
    s
}

fn is_suggestion_key(k: &str) -> bool {
    k.starts_with("suggestion_insert--")
        || k.starts_with("suggestion_delete--")
        || k.starts_with("format_change--")
}

fn is_format_change_key(k: &str) -> bool {
    k.starts_with("format_change--")
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
                let keys = map[i..i + q.len()]
                    .iter()
                    .flat_map(|m| m.2.iter().flat_map(|a| a.keys().map(|k| k.to_string())))
                    .collect();
                found.push(Range {
                    text: t.clone(),
                    start,
                    len: end - start,
                    overlaps_suggestion: gaps || marked,
                    formatting,
                    keys,
                });
                i += q.len();
            } else {
                i += 1;
            }
        }
    }
    match found.len() {
        0 if spans_footnote(txn, &el, quote) => Err(AnchorError::SpansFootnote(quote.into())),
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
        free_key("comment_anchor", comment_id, &r.keys),
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
            attrs1(free_key("suggestion_delete", id, &r.keys), meta.clone()),
        );
    }
    if !replacement.is_empty() {
        let mut a = r.formatting.clone();
        let taken = a.keys().map(|k| k.to_string()).collect();
        a.extend(attrs1(free_key("suggestion_insert", id, &taken), meta));
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

fn find_block<'a>(
    txn: &TransactionMut<'a>,
    block: &str,
) -> Result<yrs::types::xml::XmlElementRef, AnchorError> {
    let frag = txn
        .get_xml_fragment(FRAGMENT)
        .ok_or_else(|| AnchorError::BlockNotFound(block.into()))?;
    frag.children(txn)
        .find_map(|c| match c {
            XmlOut::Element(e)
                if block_id(AsRef::<yrs::branch::Branch>::as_ref(&e).id()) == block =>
            {
                Some(e)
            }
            _ => None,
        })
        .ok_or_else(|| AnchorError::BlockNotFound(block.into()))
}

/// Current paragraph `style` attribute (`body` when unset).
pub fn paragraph_style(txn: &TransactionMut, block: &str) -> Result<String, AnchorError> {
    let e = find_block(txn, block)?;
    if e.tag().as_ref() != "paragraph" {
        return Err(AnchorError::BlockNotFound(block.into()));
    }
    Ok(e.get_attribute(txn, "style")
        .and_then(|v| match v {
            Out::Any(Any::String(s)) => Some(s.to_string()),
            _ => None,
        })
        .unwrap_or_else(|| "body".into()))
}

fn text_unit_len(doc: &Doc, txn: &TransactionMut, t: &XmlTextRef) -> u32 {
    let mut n = 0u32;
    for d in t.diff(txn, YChange::identity) {
        let Out::Any(Any::String(s)) = &d.insert else {
            continue;
        };
        for ch in s.chars() {
            let mut buf = [0u8; 4];
            n += units(doc, ch.encode_utf8(&mut buf));
        }
    }
    n
}

fn block_text_keys(
    txn: &TransactionMut,
    el: &impl XmlFragment,
) -> std::collections::HashSet<String> {
    let mut texts = Vec::new();
    collect_texts(txn, el, &mut texts);
    let mut keys = std::collections::HashSet::new();
    for t in texts {
        for d in t.diff(txn, YChange::identity) {
            if let Some(a) = d.attributes.as_ref() {
                keys.extend(a.keys().map(|k| k.to_string()));
            }
        }
    }
    keys
}

/// True when any run in the block already carries a `format_change` mark.
pub fn block_has_format_change(txn: &TransactionMut, block: &str) -> Result<bool, AnchorError> {
    let el = find_block(txn, block)?;
    Ok(block_text_keys(txn, &el)
        .into_iter()
        .any(|k| is_format_change_key(&k)))
}

/// Mark every text run in a paragraph with a `format_change` for a proposed style change.
#[allow(clippy::too_many_arguments)]
pub fn add_paragraph_format_change(
    doc: &Doc,
    txn: &mut TransactionMut,
    block: &str,
    id: &str,
    author: &str,
    ts: &str,
    before: &str,
    after: &str,
) -> Result<(), AnchorError> {
    let el = find_block(txn, block)?;
    let mut texts = Vec::new();
    collect_texts(txn, &el, &mut texts);
    let mut keys = block_text_keys(txn, &el);
    let meta = serde_json::json!({
        "id": id,
        "author": author,
        "ts": ts,
        "target": crate::content::PARAGRAPH_STYLE_TARGET,
        "before": before,
        "after": after,
    });
    let mut marked = false;
    for t in texts {
        let len = text_unit_len(doc, txn, &t);
        if len == 0 {
            continue;
        }
        let key = free_key("format_change", id, &keys);
        keys.insert(key.clone());
        t.format(txn, 0, len, attrs1(key, meta.clone()));
        marked = true;
    }
    if !marked {
        return Err(AnchorError::NoMarkableText);
    }
    Ok(())
}
