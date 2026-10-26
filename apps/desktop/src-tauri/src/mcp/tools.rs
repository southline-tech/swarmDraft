//! MCP tools. RAD-209: read tools (`list_documents`, `list_chapters`, `read_chapter`,
//! `search_text`). RAD-210: `add_comment`, `suggest_edit`, `suggest_style`, all attributed to
//! the calling agent. There is deliberately no tool that accepts or rejects a suggestion: that
//! decision is human-only.

use axum::http::request::Parts;
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::tool::Extension;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock, ServerCapabilities, ServerConfig};
use rmcp::{schemars, tool, tool_handler, tool_router, ErrorData, ServerHandler};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::agents::AgentPrincipal;
use crate::content;
use crate::manuscripts::AgentWrite;
use crate::storage::{StorageError, Store};

/// A tool failure the agent should see (`isError: true`), with its audit outcome.
pub(crate) struct ToolErr {
    pub outcome: &'static str,
    pub message: String,
}

impl ToolErr {
    pub fn invalid(m: impl Into<String>) -> Self {
        Self {
            outcome: "error",
            message: m.into(),
        }
    }
}

impl From<StorageError> for ToolErr {
    fn from(e: StorageError) -> Self {
        Self {
            outcome: "error",
            message: e.to_string(),
        }
    }
}

/// Length caps (in characters) on agent-supplied text, so one call can't bloat the document,
/// the database or the audit log.
pub const MAX_COMMENT: usize = 4000;
pub const MAX_QUOTE: usize = 2000;
pub const MAX_REPLACEMENT: usize = 4000;
pub const MAX_RATIONALE: usize = 2000;
pub const MAX_QUERY: usize = 500;
pub const MAX_ID: usize = 128;

fn check_ids(ids: &[(&str, Option<&str>)]) -> Result<(), ToolErr> {
    for (field, v) in ids {
        if let Some(v) = v {
            check_len(field, v, MAX_ID)?;
        }
    }
    Ok(())
}

fn check_len(field: &str, value: &str, max: usize) -> Result<(), ToolErr> {
    let n = value.chars().count();
    if n > max {
        return Err(ToolErr::invalid(format!(
            "{field} is too long ({n} characters; the limit is {max})"
        )));
    }
    Ok(())
}

/// Shortens a value for the audit log so an over-long argument isn't stored in full.
fn clip(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        value.to_string()
    } else {
        value.chars().take(max).collect::<String>() + "…"
    }
}

fn clip_opt(value: &Option<String>, max: usize) -> Option<String> {
    value.as_deref().map(|v| clip(v, max))
}

pub(crate) enum Output {
    Json(Value),
    Text(String),
}

#[derive(Clone)]
pub struct CoauthorMcp {
    pub(crate) store: Store,
    tool_router: ToolRouter<Self>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ManuscriptArgs {
    /// Manuscript id from `list_documents`.
    pub manuscript_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ReadFormat {
    /// Markdown with `<!-- block:ID -->` markers and CriticMarkup for suggestions and comments.
    #[default]
    Markdown,
    /// ProseMirror JSON blocks with ids, plus the read view, comments and suggestions.
    Json,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ReadChapterArgs {
    pub manuscript_id: String,
    /// Section id from `list_chapters`.
    pub section_id: String,
    #[serde(default)]
    pub format: ReadFormat,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SearchArgs {
    pub manuscript_id: String,
    /// Case-insensitive plain-text query.
    pub query: String,
    /// Maximum matches (default 20, max 100).
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct AddCommentArgs {
    pub manuscript_id: String,
    pub section_id: String,
    /// Block id from `read_chapter` or `search_text`. Optional for replies.
    pub block_id: Option<String>,
    /// Exact text inside the block to anchor to (must occur once). Optional for replies.
    pub quote: Option<String>,
    pub body: String,
    /// Reply to this comment id instead of starting a new thread.
    pub thread_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SuggestEditArgs {
    pub manuscript_id: String,
    pub section_id: String,
    pub block_id: String,
    /// Exact text inside the block to replace (must occur once).
    pub quote: String,
    /// Replacement text; empty suggests deleting the quote.
    pub replacement: String,
    pub rationale: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SuggestStyleArgs {
    pub manuscript_id: String,
    pub section_id: String,
    pub block_id: String,
    /// One of: body, first, block_quote, epigraph, verse, centered.
    pub style: String,
    pub rationale: Option<String>,
}

pub const PARAGRAPH_STYLES: &[&str] = &[
    "body",
    "first",
    "block_quote",
    "epigraph",
    "verse",
    "centered",
];

fn author(p: &AgentPrincipal) -> crate::manuscripts::Author {
    crate::manuscripts::Author {
        kind: "agent".into(),
        id: p.agent_id.clone(),
        name: p.name.clone(),
    }
}

fn principal(parts: &Parts) -> Result<AgentPrincipal, ErrorData> {
    parts
        .extensions
        .get::<AgentPrincipal>()
        .cloned()
        .ok_or_else(|| ErrorData::invalid_request("unauthenticated", None))
}

impl CoauthorMcp {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            tool_router: Self::tool_router(),
        }
    }

    /// Scope check, run, audit. Every tool goes through here.
    pub(crate) fn run(
        &self,
        parts: &Parts,
        scope: &str,
        action: &str,
        manuscript_id: Option<&str>,
        args: Value,
        f: impl FnOnce(&AgentPrincipal) -> Result<Output, ToolErr>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = principal(parts)?;
        let result = if p.has_scope(scope) {
            f(&p)
        } else {
            Err(ToolErr {
                outcome: "denied",
                message: format!("token lacks the '{scope}' scope"),
            })
        };
        let outcome = match &result {
            Ok(_) => "ok",
            Err(e) => e.outcome,
        };
        let mut payload = json!({ "tokenId": p.token_id, "args": args });
        if let Err(e) = &result {
            payload["error"] = Value::String(e.message.clone());
        }
        self.store
            .audit(
                "agent",
                &p.agent_id,
                manuscript_id,
                action,
                outcome,
                &payload,
            )
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(match result {
            Ok(Output::Json(v)) => CallToolResult::structured(v),
            Ok(Output::Text(t)) => CallToolResult::success(vec![ContentBlock::text(t)]),
            Err(e) => CallToolResult::error(vec![ContentBlock::text(e.message)]),
        })
    }

    pub(crate) fn section_blocks(
        &self,
        manuscript_id: &str,
        section_id: &str,
    ) -> Result<(crate::manuscripts::Section, Vec<content::Block>), ToolErr> {
        let s = self.store.get_section(manuscript_id, section_id)?;
        let doc = self.store.load_doc(&s.doc_id)?;
        Ok((s, content::decode_checked(&doc).map_err(ToolErr::invalid)?))
    }
}

#[tool_router]
impl CoauthorMcp {
    #[tool(description = "List the manuscripts in this workspace.")]
    async fn list_documents(
        &self,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, ErrorData> {
        self.run(&parts, "read", "list_documents", None, json!({}), |_| {
            let mut out = Vec::new();
            for m in self.store.list_manuscripts()? {
                let n = self.store.list_sections(&m.id)?.len();
                out.push(json!({ "id": m.id, "title": m.title, "createdAt": m.created_at, "sectionCount": n }));
            }
            Ok(Output::Json(json!({ "documents": out })))
        })
    }

    #[tool(
        description = "List a manuscript's sections (front matter, parts, chapters, scenes, back matter) in order, with word counts."
    )]
    async fn list_chapters(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(a): Parameters<ManuscriptArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = json!({ "manuscriptId": a.manuscript_id });
        self.run(
            &parts,
            "read",
            "list_chapters",
            Some(&a.manuscript_id),
            args,
            |_| {
                let mut out = Vec::new();
                for s in self.store.list_sections(&a.manuscript_id)? {
                    let blocks = content::decode_checked(&self.store.load_doc(&s.doc_id)?)
                        .map_err(ToolErr::invalid)?;
                    out.push(json!({
                        "id": s.id, "kind": s.kind, "title": s.title, "position": s.position,
                        "parentId": s.parent_id, "wordCount": content::word_count(&blocks),
                    }));
                }
                Ok(Output::Json(json!({ "sections": out })))
            },
        )
    }

    #[tool(
        description = "Read one section. Markdown (default) marks each block with <!-- block:ID --> and shows suggestions as {++insert++}/{--delete--} and comments as {==quote==}, each followed by {>>kind:id<<}, with notes as [^id]. JSON returns the blocks with ids, the read view text and notes, and open comments and suggestions. Block ids are stable anchors for comments and suggestions."
    )]
    async fn read_chapter(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(a): Parameters<ReadChapterArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = json!({ "manuscriptId": a.manuscript_id, "sectionId": a.section_id, "format": format!("{:?}", a.format).to_lowercase() });
        self.run(
            &parts,
            "read",
            "read_chapter",
            Some(&a.manuscript_id),
            args,
            |_| {
                let (s, blocks) = self.section_blocks(&a.manuscript_id, &a.section_id)?;
                let comments = self.store.open_comments(&s.id)?;
                let suggestions = self.store.open_suggestions(&s.id)?;
                Ok(match a.format {
                    ReadFormat::Json => Output::Json(json!({
                        "section": s,
                        "blocks": blocks,
                        "readView": content::read_view(&blocks),
                        "comments": comments,
                        "suggestions": suggestions,
                    })),
                    ReadFormat::Markdown => {
                        let mut md = format!("# {}\n\n{}", s.title, content::markdown(&blocks));
                        if !comments.is_empty() || !suggestions.is_empty() {
                            md.push_str("\n\n---\nOpen items:\n");
                            for c in &comments {
                                md.push_str(&format!(
                                    "- comment:{} by {} on block {}: {}\n",
                                    c.id,
                                    c.author.name,
                                    c.block_id.as_deref().unwrap_or("-"),
                                    c.body
                                ));
                            }
                            for x in &suggestions {
                                md.push_str(&format!(
                                    "- suggestion:{} ({}) by {} on block {}{}\n",
                                    x.id,
                                    x.kind,
                                    x.author.name,
                                    x.block_id.as_deref().unwrap_or("-"),
                                    x.rationale
                                        .as_deref()
                                        .map(|r| format!(": {r}"))
                                        .unwrap_or_default()
                                ));
                            }
                        }
                        Output::Text(md)
                    }
                })
            },
        )
    }

    #[tool(
        description = "Case-insensitive text search across a manuscript. Returns section id, block id, offset and length in UTF-16 code units (as in JavaScript strings), a snippet, and the exact matched text to use as `quote` when anchoring a comment or suggestion."
    )]
    async fn search_text(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(a): Parameters<SearchArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = json!({ "manuscriptId": a.manuscript_id, "query": clip(&a.query, MAX_QUERY), "limit": a.limit });
        self.run(
            &parts,
            "read",
            "search_text",
            Some(&a.manuscript_id),
            args,
            |_| {
                check_ids(&[("manuscript_id", Some(&a.manuscript_id))])?;
                check_len("query", &a.query, MAX_QUERY)?;
                let q: Vec<char> = a.query.to_lowercase().chars().collect();
                if q.is_empty() {
                    return Err(ToolErr::invalid("query must not be empty"));
                }
                let limit = a.limit.unwrap_or(20).clamp(1, 100);
                let mut hits = Vec::new();
                'outer: for s in self.store.list_sections(&a.manuscript_id)? {
                    for b in content::decode_checked(&self.store.load_doc(&s.doc_id)?)
                        .map_err(ToolErr::invalid)?
                    {
                        let text: Vec<char> = content::block_text(&b.node).chars().collect();
                        let lower: Vec<char> = text
                            .iter()
                            .map(|c| c.to_lowercase().next().unwrap_or(*c))
                            .collect();
                        let mut i = 0;
                        while i + q.len() <= lower.len() {
                            if lower[i..i + q.len()] == q[..] {
                                let from = i.saturating_sub(40);
                                let to = (i + q.len() + 40).min(text.len());
                                // Positions are UTF-16 code units, like the editor and Yjs.
                                let u16 =
                                    |cs: &[char]| cs.iter().map(|c| c.len_utf16()).sum::<usize>();
                                hits.push(json!({
                                    "sectionId": s.id, "sectionTitle": s.title, "blockId": b.id,
                                    "offset": u16(&text[..i]), "length": u16(&text[i..i + q.len()]),
                                    "quote": text[i..i + q.len()].iter().collect::<String>(),
                                    "snippet": text[from..to].iter().collect::<String>(),
                                }));
                                if hits.len() >= limit {
                                    break 'outer;
                                }
                                i += q.len();
                            } else {
                                i += 1;
                            }
                        }
                    }
                }
                Ok(Output::Json(json!({ "matches": hits })))
            },
        )
    }

    #[tool(
        description = "Add a comment anchored to an exact quote inside a block (or reply to a comment with thread_id). The comment is attributed to you."
    )]
    async fn add_comment(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(a): Parameters<AddCommentArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = json!({ "sectionId": a.section_id, "blockId": a.block_id, "quote": clip_opt(&a.quote, MAX_QUOTE), "threadId": a.thread_id });
        self.run(
            &parts,
            "comment",
            "add_comment",
            Some(&a.manuscript_id),
            args,
            |p| {
                if a.body.trim().is_empty() {
                    return Err(ToolErr::invalid("body must not be empty"));
                }
                check_ids(&[
                    ("manuscript_id", Some(&a.manuscript_id)),
                    ("section_id", Some(&a.section_id)),
                    ("block_id", a.block_id.as_deref()),
                    ("thread_id", a.thread_id.as_deref()),
                ])?;
                check_len("body", &a.body, MAX_COMMENT)?;
                if let Some(q) = &a.quote {
                    check_len("quote", q, MAX_QUOTE)?;
                }
                let s = self.store.get_section(&a.manuscript_id, &a.section_id)?;
                let id = format!("c{}", crate::manuscripts::new_id());
                let mut edited: Option<(yrs::Doc, yrs::StateVector)> = None;
                let (block_id, quote) = match (&a.thread_id, &a.block_id, &a.quote) {
                    (Some(t), _, _) => {
                        let parent = self
                            .store
                            .get_comment(t)?
                            .filter(|c| c.section_id == s.id)
                            .ok_or_else(|| {
                                ToolErr::invalid(format!("comment {t} not found in this section"))
                            })?;
                        (parent.block_id, parent.quote)
                    }
                    (None, Some(b), Some(q)) => {
                        let doc = self.store.load_doc(&s.doc_id)?;
                        let sv = crate::manuscripts::state_vector(&doc);
                        let review_before = blocks_of(&doc);
                        {
                            let mut txn = yrs::Transact::transact_mut(&doc);
                            let r = crate::anchor::resolve(&doc, &txn, b, q)
                                .map_err(|e| ToolErr::invalid(e.to_string()))?;
                            crate::anchor::add_comment_mark(&mut txn, &r, &id);
                        }
                        check_schema(&doc)?;
                        {
                            let (b, a) = review_marks_pair(&review_before, &blocks_of(&doc));
                            check_review_marks(&b, &a)?;
                        }
                        edited = Some((doc, sv));
                        (Some(b.clone()), Some(q.clone()))
                    }
                    _ => {
                        return Err(ToolErr::invalid(
                            "give block_id and quote, or thread_id for a reply",
                        ))
                    }
                };
                let c = crate::manuscripts::Comment {
                    id,
                    section_id: s.id.clone(),
                    block_id,
                    quote,
                    body: a.body.clone(),
                    thread_id: a.thread_id.clone(),
                    author: author(p),
                    created_at: self.store.now()?,
                };
                self.store.agent_write(
                    &p.token_id,
                    AgentWrite {
                        manuscript_id: &a.manuscript_id,
                        doc: edited.as_ref().map(|(d, sv)| (s.doc_id.as_str(), d, sv)),
                        comment: Some(&c),
                        suggestion: None,
                    },
                )?;
                Ok(Output::Json(json!({ "comment": c })))
            },
        )
    }

    #[tool(
        description = "Suggest replacing (or, with an empty replacement, deleting) an exact quote inside a block. Recorded as a tracked change attributed to you; the text is not changed until the author accepts it."
    )]
    async fn suggest_edit(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(a): Parameters<SuggestEditArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = json!({ "sectionId": a.section_id, "blockId": a.block_id, "quote": clip(&a.quote, MAX_QUOTE), "replacement": clip(&a.replacement, MAX_REPLACEMENT) });
        self.run(
            &parts,
            "suggest",
            "suggest_edit",
            Some(&a.manuscript_id),
            args,
            |p| {
                check_ids(&[
                    ("manuscript_id", Some(&a.manuscript_id)),
                    ("section_id", Some(&a.section_id)),
                    ("block_id", Some(&a.block_id)),
                ])?;
                check_len("quote", &a.quote, MAX_QUOTE)?;
                check_len("replacement", &a.replacement, MAX_REPLACEMENT)?;
                if let Some(r) = &a.rationale {
                    check_len("rationale", r, MAX_RATIONALE)?;
                }
                if a.quote == a.replacement {
                    return Err(ToolErr::invalid("replacement is the same as the quote"));
                }
                let s = self.store.get_section(&a.manuscript_id, &a.section_id)?;
                let id = format!("s{}", crate::manuscripts::new_id());
                let ts = self.store.now()?;
                let doc = self.store.load_doc(&s.doc_id)?;
                let sv = crate::manuscripts::state_vector(&doc);
                let review_before = blocks_of(&doc);
                {
                    let mut txn = yrs::Transact::transact_mut(&doc);
                    let r = crate::anchor::resolve(&doc, &txn, &a.block_id, &a.quote)
                        .map_err(|e| ToolErr::invalid(e.to_string()))?;
                    if r.overlaps_suggestion {
                        return Err(ToolErr::invalid(
                            crate::anchor::AnchorError::OverlapsSuggestion.to_string(),
                        ));
                    }
                    crate::anchor::add_suggestion_marks(
                        &mut txn,
                        &r,
                        &id,
                        &format!("agent:{}", p.agent_id),
                        &ts,
                        &a.replacement,
                    );
                }
                check_schema(&doc)?;
                {
                    let (b, a) = review_marks_pair(&review_before, &blocks_of(&doc));
                    check_review_marks(&b, &a)?;
                }
                let x = crate::manuscripts::Suggestion {
                    id,
                    section_id: s.id.clone(),
                    block_id: Some(a.block_id.clone()),
                    kind: if a.replacement.is_empty() {
                        "delete"
                    } else {
                        "replace"
                    }
                    .into(),
                    quote: Some(a.quote.clone()),
                    replacement: Some(a.replacement.clone()),
                    rationale: a.rationale.clone(),
                    author: author(p),
                    status: "open".into(),
                    created_at: ts,
                };
                self.store.agent_write(
                    &p.token_id,
                    AgentWrite {
                        manuscript_id: &a.manuscript_id,
                        doc: Some((s.doc_id.as_str(), &doc, &sv)),
                        comment: None,
                        suggestion: Some(&x),
                    },
                )?;
                Ok(Output::Json(json!({ "suggestion": x })))
            },
        )
    }

    #[tool(
        description = "Suggest a paragraph style for a block (body, first, block_quote, epigraph, verse, centered). Recorded as a format suggestion attributed to you; nothing changes until the author accepts it."
    )]
    async fn suggest_style(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(a): Parameters<SuggestStyleArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = json!({ "sectionId": a.section_id, "blockId": a.block_id, "style": a.style });
        self.run(
            &parts,
            "suggest",
            "suggest_style",
            Some(&a.manuscript_id),
            args,
            |p| {
                check_ids(&[
                    ("manuscript_id", Some(&a.manuscript_id)),
                    ("section_id", Some(&a.section_id)),
                    ("block_id", Some(&a.block_id)),
                ])?;
                if let Some(r) = &a.rationale {
                    check_len("rationale", r, MAX_RATIONALE)?;
                }
                if !PARAGRAPH_STYLES.contains(&a.style.as_str()) {
                    return Err(ToolErr::invalid(format!(
                        "unknown style {:?}; use one of {}",
                        a.style,
                        PARAGRAPH_STYLES.join(", ")
                    )));
                }
                let s = self.store.get_section(&a.manuscript_id, &a.section_id)?;
                let doc = self.store.load_doc(&s.doc_id)?;
                let kind = {
                    let txn = yrs::Transact::transact_mut(&doc);
                    crate::anchor::block_kind(&txn, &a.block_id)
                };
                match kind.as_deref() {
                    Some("paragraph") => {}
                    Some(k) => {
                        return Err(ToolErr::invalid(format!(
                            "block {} is a {k}; styles apply to paragraphs",
                            a.block_id
                        )))
                    }
                    None => {
                        return Err(ToolErr::invalid(
                            crate::anchor::AnchorError::BlockNotFound(a.block_id.clone())
                                .to_string(),
                        ))
                    }
                }
                let x = crate::manuscripts::Suggestion {
                    id: format!("s{}", crate::manuscripts::new_id()),
                    section_id: s.id.clone(),
                    block_id: Some(a.block_id.clone()),
                    kind: "style".into(),
                    quote: None,
                    replacement: Some(a.style.clone()),
                    rationale: a.rationale.clone(),
                    author: author(p),
                    status: "open".into(),
                    created_at: self.store.now()?,
                };
                self.store.agent_write(
                    &p.token_id,
                    AgentWrite {
                        manuscript_id: &a.manuscript_id,
                        doc: None,
                        comment: None,
                        suggestion: Some(&x),
                    },
                )?;
                Ok(Output::Json(json!({ "suggestion": x })))
            },
        )
    }
}

const REVIEW_MARKS: &[&str] = &["comment_anchor", "suggestion_insert", "suggestion_delete"];

/// One contiguous stretch of a review mark: where it sits (block id, plus `#fn<n>.<k>` for the
/// k-th paragraph of the n-th footnote), its UTF-16 start/end there, the text it covers and its
/// attrs.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct MarkRange {
    pub block: String,
    pub start: usize,
    pub end: usize,
    pub text: String,
    pub attrs: serde_json::Value,
    /// Other review marks on the same text (only compared for ids with inconsistent attrs).
    pub with: Vec<(String, String)>,
}

/// Every review mark in a section, keyed by (mark type, attrs.id), as its ordered ranges.
pub(crate) type ReviewMarks = std::collections::BTreeMap<(String, String), Vec<MarkRange>>;

fn review_keys(node: &serde_json::Value) -> Vec<(String, String, serde_json::Value)> {
    node["marks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let ty = m["type"].as_str()?;
            REVIEW_MARKS.contains(&ty).then(|| {
                let id = m["attrs"]["id"].as_str().unwrap_or("").to_string();
                (ty.to_string(), id, m["attrs"].clone())
            })
        })
        .collect()
}

/// Walk one text container. Text carrying a suggestion_insert whose id is in `skip` (added by
/// this write) is invisible: it takes no positions and joins no ranges, so positions compare in
/// the pre-write coordinates.
fn walk(
    block: &str,
    content: &serde_json::Value,
    skip: &std::collections::BTreeSet<String>,
    out: &mut ReviewMarks,
) {
    let mut pos = 0usize;
    let mut fns = 0usize;
    for n in content.as_array().into_iter().flatten() {
        if n["type"] == "text" {
            let keys = review_keys(n);
            if keys
                .iter()
                .any(|(t, i, _)| t == "suggestion_insert" && skip.contains(i))
            {
                continue;
            }
            let text = n["text"].as_str().unwrap_or("");
            let len = text.encode_utf16().count();
            let all: Vec<(String, String)> = keys
                .iter()
                .map(|(t, i, _)| (t.clone(), i.clone()))
                .collect();
            for (ty, id, attrs) in keys {
                let with: Vec<_> = all
                    .iter()
                    .filter(|k| **k != (ty.clone(), id.clone()))
                    .cloned()
                    .collect();
                let rs = out.entry((ty, id)).or_default();
                match rs.last_mut() {
                    Some(r)
                        if r.block == block
                            && r.end == pos
                            && r.attrs == attrs
                            && r.with == with =>
                    {
                        r.end += len;
                        r.text.push_str(text);
                    }
                    _ => rs.push(MarkRange {
                        block: block.to_string(),
                        start: pos,
                        end: pos + len,
                        text: text.to_string(),
                        attrs,
                        with,
                    }),
                }
            }
            pos += len;
        } else {
            if n["type"] == "footnote" {
                walk(
                    &format!("{block}#fn{fns}"),
                    &n["attrs"]["content"],
                    skip,
                    out,
                );
                fns += 1;
            }
            pos += 1;
        }
    }
}

fn collect(
    blocks: &[(String, serde_json::Value)],
    skip: &std::collections::BTreeSet<String>,
) -> ReviewMarks {
    let mut out = ReviewMarks::new();
    for (id, node) in blocks {
        walk(id, &node["content"], skip, &mut out);
    }
    out
}

/// Review marks before and after a write. Positions after the write ignore text this write
/// inserted as a new suggestion.
pub(crate) fn review_marks_pair(
    before: &[(String, serde_json::Value)],
    after: &[(String, serde_json::Value)],
) -> (ReviewMarks, ReviewMarks) {
    let b = collect(before, &Default::default());
    let all = collect(after, &Default::default());
    let new_inserts = all
        .keys()
        .filter(|k| k.0 == "suggestion_insert" && !b.contains_key(*k))
        .map(|k| k.1.clone())
        .collect();
    (b, collect(after, &new_inserts))
}

fn blocks_of(doc: &yrs::Doc) -> Vec<(String, serde_json::Value)> {
    crate::content::decode(doc)
        .into_iter()
        .map(|b| (b.id, b.node))
        .collect()
}

/// Agent writes may only add review marks. Every existing comment anchor and suggestion mark
/// (matched by type and attrs.id) must keep exactly the same ordered ranges (block, UTF-16
/// start/end, covered text, attrs), so a write can't remove, move, split, merge or edit inside
/// one. Ids whose attrs are already inconsistent can't be touched at all, not even by layering
/// a new mark over them.
pub(crate) fn check_review_marks(before: &ReviewMarks, after: &ReviewMarks) -> Result<(), ToolErr> {
    for ((ty, id), rs) in before {
        let Some(now) = after.get(&(ty.clone(), id.clone())) else {
            return Err(ToolErr::invalid(format!(
                "write refused: it would remove {ty} {id}"
            )));
        };
        let inconsistent = rs.iter().any(|r| r.attrs != rs[0].attrs);
        let strip = |v: &[MarkRange]| -> Vec<MarkRange> {
            v.iter()
                .map(|r| MarkRange {
                    with: vec![],
                    ..r.clone()
                })
                .collect()
        };
        let same = if inconsistent {
            now == rs
        } else {
            // Merge stretches split only by newly layered marks before comparing.
            let merge = |v: Vec<MarkRange>| {
                let mut o: Vec<MarkRange> = Vec::new();
                for r in v {
                    match o.last_mut() {
                        Some(p) if p.block == r.block && p.end == r.start && p.attrs == r.attrs => {
                            p.end = r.end;
                            p.text.push_str(&r.text);
                        }
                        _ => o.push(r),
                    }
                }
                o
            };
            merge(strip(now)) == merge(strip(rs))
        };
        if !same {
            return Err(ToolErr::invalid(if inconsistent {
                format!("write refused: {ty} {id} has inconsistent attrs and can't be touched")
            } else {
                format!("write refused: it would change {ty} {id}")
            }));
        }
    }
    Ok(())
}

/// Every MCP write must leave the section with only schema-known nodes and marks; otherwise the
/// call fails and nothing is saved (the edited doc is a per-call copy).
fn check_schema(doc: &yrs::Doc) -> Result<(), ToolErr> {
    let nodes: Vec<serde_json::Value> = crate::content::decode(doc)
        .into_iter()
        .map(|b| b.node)
        .collect();
    crate::content::validate_doc(&json!({ "type": "doc", "content": nodes }))
        .map_err(|e| ToolErr::invalid(format!("write refused: {e}")))
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for CoauthorMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build()).with_instructions(
            "coAuthor manuscript tools. Read with list_documents, list_chapters, read_chapter and \
             search_text; comment with add_comment and propose changes with suggest_edit and \
             suggest_style. Anchor comments and suggestions with a block id plus an exact quote. \
             Accepting or rejecting suggestions is reserved for the human author.",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// A text node; `marks` are review marks.
    fn x(text: &str, marks: Value) -> Value {
        json!({"type": "text", "text": text, "marks": marks})
    }
    fn p(id: &str, content: Vec<Value>) -> (String, Value) {
        (id.into(), json!({"type": "paragraph", "content": content}))
    }
    fn c(id: &str) -> Value {
        json!({"type": "comment_anchor", "attrs": {"id": id}})
    }
    fn d(id: &str) -> Value {
        json!({"type": "suggestion_delete", "attrs": {"id": id, "author": "a", "ts": "1"}})
    }
    fn d_by(id: &str, author: &str) -> Value {
        json!({"type": "suggestion_delete", "attrs": {"id": id, "author": author, "ts": "1"}})
    }
    fn ins(id: &str) -> Value {
        json!({"type": "suggestion_insert", "attrs": {"id": id, "author": "a", "ts": "2"}})
    }
    fn check(before: &[(String, Value)], after: &[(String, Value)]) -> Result<(), String> {
        let (b, a) = review_marks_pair(before, after);
        check_review_marks(&b, &a).map_err(|e| e.message)
    }

    #[test]
    fn adding_review_marks_is_allowed() {
        let before = [p("b1", vec![x("lantern", json!([c("c1")]))])];
        let after = [p(
            "b1",
            vec![x("lantern", json!([c("c1"), c("c2"), d("s1")]))],
        )];
        assert!(check(&before, &after).is_ok());
        // A new suggestion's inserted text before an existing mark doesn't shift it.
        let before = [p(
            "b1",
            vec![x("old ", json!([])), x("lantern", json!([c("c1")]))],
        )];
        let after = [p(
            "b1",
            vec![
                x("old ", json!([d("s2")])),
                x("new ", json!([ins("s2")])),
                x("lantern", json!([c("c1")])),
            ],
        )];
        assert!(check(&before, &after).is_ok());
    }

    #[test]
    fn removing_a_review_mark_is_refused() {
        let before = [p("b1", vec![x("lantern", json!([c("c1"), d("s1")]))])];
        let e = check(&before, &[p("b1", vec![x("lantern", json!([d("s1")]))])]).unwrap_err();
        assert!(e.contains("remove comment_anchor c1"), "{e}");
    }

    #[test]
    fn changing_attrs_or_covered_text_is_refused() {
        let before = [p("b1", vec![x("lantern", json!([d("s1")]))])];
        let e = check(
            &before,
            &[p("b1", vec![x("lantern", json!([d_by("s1", "b")]))])],
        )
        .unwrap_err();
        assert!(e.contains("change suggestion_delete s1"), "{e}");
        let e = check(&before, &[p("b1", vec![x("lamp", json!([d("s1")]))])]).unwrap_err();
        assert!(e.contains("change suggestion_delete s1"), "{e}");
    }

    #[test]
    fn unmarked_text_inside_a_suggestion_is_refused() {
        let before = [p("b1", vec![x("abcd", json!([d("s1")]))])];
        let after = [p(
            "b1",
            vec![
                x("ab", json!([d("s1")])),
                x("XX", json!([])),
                x("cd", json!([d("s1")])),
            ],
        )];
        let e = check(&before, &after).unwrap_err();
        assert!(e.contains("change suggestion_delete s1"), "{e}");
    }

    #[test]
    fn moving_a_boundary_between_same_id_ranges_is_refused() {
        // ab|cd -> abc|d with an unmarked gap between the two ranges.
        let before = [p(
            "b1",
            vec![
                x("ab", json!([c("c1")])),
                x("-", json!([])),
                x("cd", json!([c("c1")])),
            ],
        )];
        let after = [p(
            "b1",
            vec![
                x("abc", json!([c("c1")])),
                x("-", json!([])),
                x("d", json!([c("c1")])),
            ],
        )];
        let e = check(&before, &after).unwrap_err();
        assert!(e.contains("change comment_anchor c1"), "{e}");
    }

    #[test]
    fn merging_ranges_or_moving_to_identical_text_elsewhere_is_refused() {
        let before = [p(
            "b1",
            vec![
                x("ab", json!([c("c1")])),
                x("-", json!([])),
                x("cd", json!([c("c1")])),
            ],
        )];
        let merged = [p("b1", vec![x("ab-cd", json!([c("c1")]))])];
        assert!(check(&before, &merged)
            .unwrap_err()
            .contains("change comment_anchor c1"));
        let joined = [p(
            "b1",
            vec![x("abcd", json!([c("c1")])), x("-", json!([]))],
        )];
        assert!(check(&before, &joined).is_err());
        // Same text, another block.
        let before = [
            p("b1", vec![x("lantern", json!([c("c1")]))]),
            p("b2", vec![x("lantern", json!([]))]),
        ];
        let after = [
            p("b1", vec![x("lantern", json!([]))]),
            p("b2", vec![x("lantern", json!([c("c1")]))]),
        ];
        assert!(check(&before, &after)
            .unwrap_err()
            .contains("change comment_anchor c1"));
    }

    #[test]
    fn ids_with_inconsistent_attrs_cannot_be_touched() {
        let before = [p(
            "b1",
            vec![
                x("ab", json!([d_by("s1", "a")])),
                x("-", json!([])),
                x("cd", json!([d_by("s1", "b")])),
            ],
        )];
        // Changing one range's attrs (even to "fix" it) is refused.
        let fixed = [p(
            "b1",
            vec![
                x("ab", json!([d_by("s1", "a")])),
                x("-", json!([])),
                x("cd", json!([d_by("s1", "a")])),
            ],
        )];
        let e = check(&before, &fixed).unwrap_err();
        assert!(e.contains("inconsistent attrs"), "{e}");
        // Layering a new mark over it is refused too.
        let layered = [p(
            "b1",
            vec![
                x("ab", json!([d_by("s1", "a"), c("c9")])),
                x("-", json!([])),
                x("cd", json!([d_by("s1", "b")])),
            ],
        )];
        assert!(check(&before, &layered)
            .unwrap_err()
            .contains("inconsistent attrs"));
        // Unrelated writes elsewhere still pass.
        let mut ok = before.to_vec();
        ok.push(p("b2", vec![x("new", json!([c("c2")]))]));
        assert!(check(&before, &ok).is_ok());
    }

    #[test]
    fn positions_are_utf16_and_footnotes_are_separate() {
        let before = [p("b1", vec![x("😀ab", json!([c("c1")]))])];
        let (b, _) = review_marks_pair(&before, &before);
        let r = &b[&("comment_anchor".to_string(), "c1".to_string())][0];
        assert_eq!((r.start, r.end), (0, 4));
        let fnote =
            json!({"type": "footnote", "attrs": {"content": [x("note", json!([c("c2")]))]}});
        let before = [p("b1", vec![x("a", json!([])), fnote])];
        let (b, _) = review_marks_pair(&before, &before);
        assert_eq!(
            b[&("comment_anchor".to_string(), "c2".to_string())][0].block,
            "b1#fn0"
        );
    }

    fn counts(store: &Store) -> (i64, i64, i64) {
        store
            .with_sql(|c| {
                let n = |q: &str| c.query_row(q, [], |r| r.get::<_, i64>(0));
                Ok((
                    n("SELECT COUNT(*) FROM doc_updates")?,
                    n("SELECT COUNT(*) FROM comments")?,
                    n("SELECT COUNT(*) FROM suggestions")?,
                ))
            })
            .unwrap()
    }

    #[tokio::test]
    async fn a_token_revoked_between_auth_and_write_writes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();
        let m = store.create_manuscript("Synthetic").unwrap();
        let s = store
            .import_section_json(
                &m.id,
                "chapter",
                "One",
                &json!({"type":"doc","content":[
                    {"type":"paragraph","content":[{"type":"text","text":"The lantern was lit."}]}
                ]}),
            )
            .unwrap();
        let b1 = crate::content::decode(&store.load_doc(&s.doc_id).unwrap())[0]
            .id
            .clone();
        let agent = store.create_agent("Synthetic agent", "#123456").unwrap();
        let scopes: Vec<String> = ["read", "comment", "suggest"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let tok = store.create_token(&agent.id, Some(&scopes)).unwrap();
        // Authenticated (the request passed auth), then revoked before the tool writes.
        let principal = store.authenticate(&tok.token).unwrap().unwrap();
        store.revoke_token(&principal.token_id).unwrap();
        let mcp = CoauthorMcp::new(store.clone());
        let parts = || {
            let (mut parts, ()) = axum::http::Request::new(()).into_parts();
            parts.extensions.insert(principal.clone());
            Extension(parts)
        };
        let before = counts(&store);
        let results = [
            mcp.add_comment(
                parts(),
                Parameters(AddCommentArgs {
                    manuscript_id: m.id.clone(),
                    section_id: s.id.clone(),
                    block_id: Some(b1.clone()),
                    quote: Some("lantern".into()),
                    body: "Synthetic note.".into(),
                    thread_id: None,
                }),
            )
            .await
            .unwrap(),
            mcp.suggest_edit(
                parts(),
                Parameters(SuggestEditArgs {
                    manuscript_id: m.id.clone(),
                    section_id: s.id.clone(),
                    block_id: b1.clone(),
                    quote: "lantern".into(),
                    replacement: "lamp".into(),
                    rationale: None,
                }),
            )
            .await
            .unwrap(),
            mcp.suggest_style(
                parts(),
                Parameters(SuggestStyleArgs {
                    manuscript_id: m.id.clone(),
                    section_id: s.id.clone(),
                    block_id: b1.clone(),
                    style: "verse".into(),
                    rationale: None,
                }),
            )
            .await
            .unwrap(),
        ];
        for r in results {
            assert_eq!(r.is_error, Some(true), "{r:?}");
            assert!(format!("{r:?}").contains("revoked"), "{r:?}");
        }
        assert_eq!(counts(&store), before, "nothing was written");
    }
}
