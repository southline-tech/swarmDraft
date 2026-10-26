//! MCP tools. RAD-209: read tools (`list_documents`, `list_chapters`, `read_chapter`,
//! `search_text`). There is deliberately no tool that accepts or rejects a suggestion.

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
        let args = json!({ "manuscriptId": a.manuscript_id, "query": a.query, "limit": a.limit });
        self.run(
            &parts,
            "read",
            "search_text",
            Some(&a.manuscript_id),
            args,
            |_| {
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
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for CoauthorMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build()).with_instructions(
            "coAuthor manuscript tools. Read with list_documents, list_chapters, read_chapter and \
             search_text. Anchor comments and suggestions with a block id plus an exact quote. \
             Accepting or rejecting suggestions is reserved for the human author.",
        )
    }
}
