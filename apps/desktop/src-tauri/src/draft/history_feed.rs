//! History panel feed: readable entries, milestones, and compare (#365).

use std::collections::{HashMap, HashSet};

use chrono::Local;
use serde::{Deserialize, Serialize};

use crate::content::{self, decode};
use crate::storage::Store;

use super::changes::{self, ChangeEntry};
use super::repo::{DraftRepo, DraftRepoError};
use super::sync;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryFeedResponse {
    pub entries: Vec<HistoryFeedEntry>,
    pub filter_authors: Vec<HistoryFilterAuthor>,
    pub word_count_now: usize,
    pub save_state: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryFilterAuthor {
    pub id: String,
    pub name: String,
    pub author_kind: String,
    pub is_bot: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum HistoryFeedEntry {
    #[serde(rename = "current")]
    Current {
        oid: String,
        time_unix: i64,
        word_count: usize,
        save_state: String,
        reason: String,
    },
    #[serde(rename = "bot")]
    Bot {
        oid: String,
        time_unix: i64,
        display_time_unix: i64,
        agent_id: String,
        agent_name: String,
        summary: String,
        suggestion_count: usize,
        suggestions: Vec<HistoryBotSuggestion>,
    },
    #[serde(rename = "authorEdit")]
    AuthorEdit {
        oid: String,
        time_unix: i64,
        chapter_title: String,
        collapsed_count: usize,
    },
    #[serde(rename = "save")]
    Save { oid: String, time_unix: i64 },
    #[serde(rename = "restore")]
    Restore {
        oid: String,
        time_unix: i64,
        source_label: String,
    },
    #[serde(rename = "milestone")]
    Milestone {
        oid: String,
        time_unix: i64,
        name: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryBotSuggestion {
    pub change_id: String,
    pub status: String,
    pub quote: String,
    pub decided_by: Option<String>,
    pub section_id: String,
    pub chapter_title: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryCompareResponse {
    pub oid: String,
    pub label_name: String,
    pub label_time_unix: i64,
    pub total_words_then: usize,
    pub total_words_now: usize,
    pub sections: Vec<HistoryCompareSection>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryCompareSection {
    pub section_id: String,
    pub title: String,
    pub added: usize,
    pub removed: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segments: Option<Vec<HistoryCompareSegment>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryCompareSegment {
    pub segment_kind: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRestorePreviewResponse {
    pub title_label: String,
    pub restore_time_unix: i64,
    pub word_count: usize,
    pub pending_review_count: u32,
    pub kept_milestone_name: String,
    pub is_milestone: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftRestoreVersionResult {
    pub oid: String,
    pub milestone_name: Option<String>,
    pub milestone_oid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_count: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookFile {
    chapters: Vec<BookSection>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookSection {
    id: String,
    kind: String,
    title: String,
}

pub(crate) fn list_feed(
    store: &Store,
    manuscript_id: &str,
    repo: &DraftRepo,
    save_state: &str,
    limit: usize,
) -> Result<HistoryFeedResponse, DraftRepoError> {
    let author = author_name(store);
    let word_count_now = word_count_live(store, manuscript_id)?;
    let head_oid = repo.head_oid()?.unwrap_or_default();
    let head_time = if head_oid.is_empty() {
        0
    } else {
        repo.commit_time_unix(&head_oid)?
    };

    let fetch = limit.saturating_mul(4).clamp(limit, 400);
    let raw = repo.list_main_commits(fetch, 0)?;
    let milestones = repo.list_milestone_tags()?;
    let sections = book_sections(repo, &head_oid)?;
    let section_titles: HashMap<String, String> = sections
        .iter()
        .map(|s| (s.id.clone(), s.title.clone()))
        .collect();

    let mut entries: Vec<HistoryFeedEntry> = Vec::new();
    entries.push(HistoryFeedEntry::Current {
        oid: head_oid.clone(),
        time_unix: head_time,
        word_count: word_count_now,
        save_state: save_state.to_string(),
        reason: "This is your book as it is now.".into(),
    });

    let mut filter_bots: HashMap<String, String> = HashMap::new();
    let mut index = 0usize;
    while index < raw.len() && entries.len() < limit + 1 {
        let commit = &raw[index];
        let first_line = commit.message.lines().next().unwrap_or("").trim();
        if first_line.starts_with("Merged bot/") {
            if let Some(entry) = bot_entry(repo, commit, first_line, &section_titles, store)? {
                filter_bots.insert(entry.agent_id.clone(), entry.agent_name.clone());
                entries.push(HistoryFeedEntry::Bot {
                    oid: entry.oid,
                    time_unix: entry.time_unix,
                    display_time_unix: entry.display_time_unix,
                    agent_id: entry.agent_id,
                    agent_name: entry.agent_name,
                    summary: entry.summary,
                    suggestion_count: entry.suggestions.len(),
                    suggestions: entry.suggestions,
                });
            }
            index += 1;
            continue;
        }
        if let Some(chapter) = edited_chapter_title(first_line) {
            let mut collapsed = 1usize;
            let newest_oid = commit.oid.clone();
            let newest_time = commit.time_unix;
            let mut next = index + 1;
            while next < raw.len() {
                let line = raw[next].message.lines().next().unwrap_or("").trim();
                if edited_chapter_title(line).as_deref() != Some(chapter.as_str()) {
                    break;
                }
                collapsed += 1;
                next += 1;
            }
            entries.push(HistoryFeedEntry::AuthorEdit {
                oid: newest_oid,
                time_unix: newest_time,
                chapter_title: chapter,
                collapsed_count: collapsed,
            });
            index = next;
            continue;
        }
        if first_line == "Saved" {
            entries.push(HistoryFeedEntry::Save {
                oid: commit.oid.clone(),
                time_unix: commit.time_unix,
            });
            index += 1;
            continue;
        }
        if first_line.starts_with("Restored version") {
            let label = first_line
                .strip_prefix("Restored version from ")
                .unwrap_or(first_line)
                .to_string();
            entries.push(HistoryFeedEntry::Restore {
                oid: commit.oid.clone(),
                time_unix: commit.time_unix,
                source_label: label,
            });
            index += 1;
            continue;
        }
        index += 1;
    }

    for tag in milestones {
        entries.push(HistoryFeedEntry::Milestone {
            oid: tag.oid,
            time_unix: tag.time_unix,
            name: tag.name,
            message: tag.message,
        });
    }

    entries.sort_by_key(|e| std::cmp::Reverse(entry_time(e)));
    // Keep current pinned at top.
    if let Some(pos) = entries
        .iter()
        .position(|e| matches!(e, HistoryFeedEntry::Current { .. }))
    {
        let current = entries.remove(pos);
        entries.insert(0, current);
    }

    let mut filter_authors = vec![HistoryFilterAuthor {
        id: "author".into(),
        name: author.clone(),
        author_kind: "human".into(),
        is_bot: false,
    }];
    let mut bot_names: Vec<(String, String)> = filter_bots.into_iter().collect();
    bot_names.sort_by(|a, b| a.1.cmp(&b.1));
    for (id, name) in bot_names {
        filter_authors.push(HistoryFilterAuthor {
            id,
            name,
            author_kind: "agent".into(),
            is_bot: true,
        });
    }

    Ok(HistoryFeedResponse {
        entries,
        filter_authors,
        word_count_now,
        save_state: save_state.to_string(),
    })
}

struct BotEntryParts {
    oid: String,
    time_unix: i64,
    display_time_unix: i64,
    agent_id: String,
    agent_name: String,
    summary: String,
    suggestions: Vec<HistoryBotSuggestion>,
}

fn bot_entry(
    repo: &DraftRepo,
    commit: &super::repo::CommitEntry,
    merged_line: &str,
    section_titles: &HashMap<String, String>,
    store: &Store,
) -> Result<Option<BotEntryParts>, DraftRepoError> {
    let branch = merged_line
        .trim()
        .strip_prefix("Merged ")
        .unwrap_or(merged_line);
    let Some((slug, _session)) = parse_bot_branch(branch) else {
        return Ok(None);
    };
    let agent_id = resolve_agent_id(store, slug);
    let parents = repo.parent_oids(&commit.oid)?;
    let bot_parent = parents.get(1).cloned();
    let display_time_unix = bot_parent
        .as_ref()
        .map(|p| repo.commit_time_unix(p))
        .transpose()?
        .unwrap_or(commit.time_unix);
    let agent_name = bot_parent
        .as_ref()
        .map(|p| repo.committer_name(p))
        .transpose()?
        .filter(|n| !n.trim().is_empty())
        .or_else(|| agent_display_name(store, &agent_id))
        .unwrap_or_else(|| "Bot".into());

    let suggestions = bot_suggestions_at_merge(repo, &commit.oid, &agent_id, section_titles)?;
    let summary = bot_summary(&suggestions, section_titles);
    Ok(Some(BotEntryParts {
        oid: commit.oid.clone(),
        time_unix: commit.time_unix,
        display_time_unix,
        agent_id,
        agent_name,
        summary,
        suggestions,
    }))
}

fn bot_summary(
    suggestions: &[HistoryBotSuggestion],
    section_titles: &HashMap<String, String>,
) -> String {
    let count = suggestions.len();
    if count == 0 {
        return "Suggestions".into();
    }
    let mut chapters: HashSet<&str> = HashSet::new();
    for s in suggestions {
        if let Some(title) = section_titles.get(&s.section_id) {
            chapters.insert(title.as_str());
        }
    }
    let noun = if count == 1 {
        "suggestion"
    } else {
        "suggestions"
    };
    if chapters.len() == 1 {
        let title = chapters.into_iter().next().unwrap_or("chapter");
        format!("{count} {noun} in {title}")
    } else {
        format!("{count} {noun}")
    }
}

fn bot_suggestions_at_merge(
    repo: &DraftRepo,
    merge_oid: &str,
    agent_id: &str,
    section_titles: &HashMap<String, String>,
) -> Result<Vec<HistoryBotSuggestion>, DraftRepoError> {
    let parents = repo.parent_oids(merge_oid)?;
    let Some(main_parent) = parents.first() else {
        return Ok(Vec::new());
    };
    let Some(bot_parent) = parents.get(1) else {
        return Ok(Vec::new());
    };
    let Some(base) = repo.merge_base(bot_parent, main_parent)? else {
        return Ok(Vec::new());
    };
    let base_ids = changes::change_ids_in_commit(repo, &base)?;
    let bot_changes = changes::changes_in_commit(repo, merge_oid)?;
    let slug = bot_slug(agent_id);
    let mut out = Vec::new();
    for entry in bot_changes {
        if base_ids.contains(&entry.id) {
            continue;
        }
        if !change_from_bot(&entry, agent_id, &slug) {
            continue;
        }
        if entry.status == "open" {
            continue;
        }
        let chapter_title = section_titles
            .get(&entry.section_id)
            .cloned()
            .unwrap_or_else(|| "Chapter".into());
        out.push(HistoryBotSuggestion {
            change_id: entry.id,
            status: entry.status,
            quote: entry.quote,
            decided_by: entry.decided_by,
            section_id: entry.section_id,
            chapter_title,
        });
    }
    out.sort_by(|a, b| a.change_id.cmp(&b.change_id));
    Ok(out)
}

fn change_from_bot(entry: &ChangeEntry, agent_id: &str, slug: &str) -> bool {
    if entry.author_kind != "agent" {
        return false;
    }
    entry.author_id == agent_id || bot_slug(&entry.author_id) == slug || entry.author_id == slug
}

pub(crate) fn compare_versions(
    store: &Store,
    manuscript_id: &str,
    repo: &DraftRepo,
    oid: &str,
    feed_label: Option<(&str, i64)>,
    include_segments: bool,
) -> Result<HistoryCompareResponse, DraftRepoError> {
    let head = repo.head_oid()?.unwrap_or_default();
    let then_sections = book_sections(repo, oid)?;
    let now_sections = book_sections(repo, &head)?;

    let (label_name, label_time_unix) = if let Some((name, time)) = feed_label {
        (name.to_string(), time)
    } else if let Ok(msg) = repo.commit_message(oid) {
        let first = msg.lines().next().unwrap_or("").trim();
        if first.starts_with("Merged bot/") {
            let parents = repo.parent_oids(oid)?;
            let display_time = parents
                .get(1)
                .and_then(|p| repo.commit_time_unix(p).ok())
                .unwrap_or_else(|| repo.commit_time_unix(oid).unwrap_or(0));
            let name = parents
                .get(1)
                .and_then(|p| repo.committer_name(p).ok())
                .unwrap_or_else(|| "Version".into());
            (name, display_time)
        } else {
            (first.to_string(), repo.commit_time_unix(oid).unwrap_or(0))
        }
    } else {
        ("Version".into(), repo.commit_time_unix(oid).unwrap_or(0))
    };

    // Current book order, then chapters that existed only in the older save.
    let mut seen: HashSet<String> = HashSet::new();
    let mut chapter_ids: Vec<(String, String)> = Vec::new();
    for section in now_sections.iter().chain(then_sections.iter()) {
        if section.kind != "chapter" || !seen.insert(section.id.clone()) {
            continue;
        }
        let title = now_sections
            .iter()
            .chain(then_sections.iter())
            .find(|s| s.id == section.id)
            .map(|s| s.title.clone())
            .unwrap_or_else(|| "Chapter".into());
        chapter_ids.push((section.id.clone(), title));
    }

    let mut total_then = 0usize;
    let mut total_now = 0usize;
    let mut sections_out = Vec::new();
    for (section_id, title) in chapter_ids {
        let then_blocks = chapter_blocks(repo, oid, &section_id)?;
        let now_blocks = chapter_blocks(repo, &head, &section_id)?;
        total_then += content::word_count(&then_blocks);
        total_now += content::word_count(&now_blocks);
        let then_paras = paragraphs_of(&then_blocks);
        let now_paras = paragraphs_of(&now_blocks);
        let (added, removed) = word_delta(&plain_text(&then_paras), &plain_text(&now_paras));
        if added == 0 && removed == 0 {
            continue;
        }
        let segments = if include_segments {
            Some(diff_paragraphs(&then_paras, &now_paras))
        } else {
            None
        };
        sections_out.push(HistoryCompareSection {
            section_id,
            title,
            added,
            removed,
            segments,
        });
    }

    if total_then == 0 && total_now == 0 {
        total_then = word_count_live(store, manuscript_id)?;
        total_now = total_then;
    } else if total_now == 0 {
        total_now = word_count_live(store, manuscript_id)?;
    }

    Ok(HistoryCompareResponse {
        oid: oid.to_string(),
        label_name,
        label_time_unix,
        total_words_then: total_then,
        total_words_now: total_now,
        sections: sections_out,
    })
}

pub(crate) fn before_restoring_milestone_name() -> String {
    Local::now().format("Before restoring · %b %d").to_string()
}

pub(crate) fn restore_preview(
    store: &Store,
    manuscript_id: &str,
    repo: &DraftRepo,
    oid: &str,
) -> Result<HistoryRestorePreviewResponse, DraftRepoError> {
    use super::changes;

    let compare = compare_versions(store, manuscript_id, repo, oid, None, false)?;
    let title_label = format!(
        "{} · {}",
        compare.label_name,
        format_when_short(compare.label_time_unix)
    );
    let word_count = compare.total_words_then;
    let kept_milestone_name = before_restoring_milestone_name();
    let is_milestone = repo
        .list_milestone_tags()?
        .into_iter()
        .any(|t| t.oid == oid);
    let pending_review_count = changes::build_change_index(store, manuscript_id)
        .map(|rows| rows.iter().filter(|c| c.status == "open").count() as u32)
        .unwrap_or(0);
    Ok(HistoryRestorePreviewResponse {
        title_label,
        restore_time_unix: compare.label_time_unix,
        word_count,
        pending_review_count,
        kept_milestone_name,
        is_milestone,
    })
}

fn format_when_short(unix: i64) -> String {
    chrono::DateTime::from_timestamp(unix, 0)
        .map(|dt| {
            dt.with_timezone(&Local)
                .format("%b %d, %I:%M %p")
                .to_string()
        })
        .unwrap_or_else(|| "unknown time".into())
}

fn entry_time(entry: &HistoryFeedEntry) -> i64 {
    match entry {
        HistoryFeedEntry::Current { time_unix, .. }
        | HistoryFeedEntry::Bot { time_unix, .. }
        | HistoryFeedEntry::AuthorEdit { time_unix, .. }
        | HistoryFeedEntry::Save { time_unix, .. }
        | HistoryFeedEntry::Restore { time_unix, .. }
        | HistoryFeedEntry::Milestone { time_unix, .. } => *time_unix,
    }
}

fn author_name(store: &Store) -> String {
    store
        .user_display_name()
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Author".to_string())
}

fn agent_display_name(store: &Store, agent_id: &str) -> Option<String> {
    store
        .list_agents()
        .ok()?
        .into_iter()
        .find(|a| a.id == agent_id)
        .map(|a| a.name)
}

fn resolve_agent_id(store: &Store, slug: &str) -> String {
    if let Ok(agents) = store.list_agents() {
        for agent in agents {
            if bot_slug(&agent.id) == slug || agent.id == slug {
                return agent.id;
            }
        }
    }
    slug.to_string()
}

fn parse_bot_branch(branch: &str) -> Option<(&str, &str)> {
    let rest = branch.strip_prefix("bot/")?;
    rest.split_once('/')
}

fn bot_slug(bot_id: &str) -> String {
    let slug: String = bot_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    if slug.is_empty() {
        "bot".into()
    } else {
        slug
    }
}

fn edited_chapter_title(first_line: &str) -> Option<String> {
    first_line.strip_prefix("Edited ").map(|rest| {
        let title = rest.trim();
        if title.is_empty() {
            "chapter".into()
        } else {
            title.to_string()
        }
    })
}

fn word_count_live(store: &Store, manuscript_id: &str) -> Result<usize, DraftRepoError> {
    let mut total = 0usize;
    for section in store.list_sections(manuscript_id).map_err(storage_err)? {
        if section.kind != "chapter" {
            continue;
        }
        let doc = store.load_doc(&section.doc_id).map_err(storage_err)?;
        total += content::word_count(&decode(&doc));
    }
    Ok(total)
}

fn book_sections(repo: &DraftRepo, oid: &str) -> Result<Vec<BookSection>, DraftRepoError> {
    if oid.is_empty() {
        return Ok(Vec::new());
    }
    let Some(bytes) = repo.file_bytes(oid, "book.json")? else {
        return Ok(Vec::new());
    };
    let book: BookFile = serde_json::from_slice(&bytes).map_err(DraftRepoError::Json)?;
    Ok(book.chapters)
}

fn chapter_blocks(
    repo: &DraftRepo,
    oid: &str,
    section_id: &str,
) -> Result<Vec<content::Block>, DraftRepoError> {
    if oid.is_empty() {
        return Ok(Vec::new());
    }
    let path = format!("yjs/{section_id}.bin");
    let Some(bytes) = repo.file_bytes(oid, &path)? else {
        return Ok(Vec::new());
    };
    let Some(doc) = sync::doc_from_update(&bytes) else {
        return Ok(Vec::new());
    };
    Ok(decode(&doc))
}

struct Para {
    id: String,
    text: String,
}

fn paragraphs_of(blocks: &[content::Block]) -> Vec<Para> {
    blocks
        .iter()
        .map(|block| Para {
            id: block.id.clone(),
            text: strip_block_markers(&content::block_text(&block.node)),
        })
        .collect()
}

fn plain_text(paras: &[Para]) -> String {
    paras
        .iter()
        .map(|para| para.text.as_str())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Drop `<!-- block:id -->` markers so compare text is the book the author reads.
fn strip_block_markers(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<!--") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 4..];
        if after.trim_start().starts_with("block:") {
            if let Some(end) = rest[start..].find("-->") {
                rest = &rest[start + end + 3..];
                continue;
            }
        }
        out.push_str("<!--");
        rest = &rest[start + 4..];
    }
    out.push_str(rest);
    out
}

fn word_delta(before: &str, after: &str) -> (usize, usize) {
    let a: Vec<&str> = before.split_whitespace().collect();
    let b: Vec<&str> = after.split_whitespace().collect();
    let (added, removed) = lcs_word_delta(&a, &b);
    (added, removed)
}

fn lcs_word_delta(a: &[&str], b: &[&str]) -> (usize, usize) {
    let n = a.len();
    let m = b.len();
    if n == 0 {
        return (m, 0);
    }
    if m == 0 {
        return (0, n);
    }
    let mut prev = vec![0usize; m + 1];
    let mut curr = vec![0usize; m + 1];
    for i in 1..=n {
        for j in 1..=m {
            if a[i - 1] == b[j - 1] {
                curr[j] = prev[j - 1] + 1;
            } else {
                curr[j] = prev[j].max(curr[j - 1]);
            }
        }
        std::mem::swap(&mut prev, &mut curr);
        curr.fill(0);
    }
    let lcs = prev[m];
    (m.saturating_sub(lcs), n.saturating_sub(lcs))
}

enum ParaOp {
    Same(usize, usize),
    Remove(usize),
    Add(usize),
}

/// Align paragraphs by block id, then diff words inside a paragraph that changed.
fn diff_paragraphs(before: &[Para], after: &[Para]) -> Vec<HistoryCompareSegment> {
    let ops = align_paragraphs(before, after);
    let mut segments = Vec::new();
    for (index, op) in ops.iter().enumerate() {
        if index > 0 {
            segments.push(HistoryCompareSegment {
                segment_kind: "gap".into(),
                text: "\n\n".into(),
            });
        }
        match op {
            ParaOp::Same(i, j) => {
                let old = before[*i].text.as_str();
                let new = after[*j].text.as_str();
                if old == new {
                    if !new.is_empty() {
                        push_segment(&mut segments, "same", new);
                    }
                } else {
                    diff_words(&mut segments, old, new);
                }
            }
            ParaOp::Remove(i) => {
                let text = before[*i].text.as_str();
                if !text.is_empty() {
                    push_segment(&mut segments, "remove", text);
                }
            }
            ParaOp::Add(j) => {
                let text = after[*j].text.as_str();
                if !text.is_empty() {
                    push_segment(&mut segments, "add", text);
                }
            }
        }
    }
    segments
}

fn align_paragraphs(before: &[Para], after: &[Para]) -> Vec<ParaOp> {
    let n = before.len();
    let m = after.len();
    let mut dp = vec![vec![0usize; m + 1]; n + 1];
    for i in 1..=n {
        for j in 1..=m {
            if before[i - 1].id == after[j - 1].id {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = dp[i - 1][j].max(dp[i][j - 1]);
            }
        }
    }
    let mut ops = Vec::new();
    let mut i = n;
    let mut j = m;
    while i > 0 || j > 0 {
        if i > 0 && j > 0 && before[i - 1].id == after[j - 1].id {
            ops.push(ParaOp::Same(i - 1, j - 1));
            i -= 1;
            j -= 1;
        } else if i > 0 && (j == 0 || dp[i - 1][j] >= dp[i][j - 1]) {
            ops.push(ParaOp::Remove(i - 1));
            i -= 1;
        } else {
            ops.push(ParaOp::Add(j - 1));
            j -= 1;
        }
    }
    ops.reverse();
    ops
}

fn diff_words(segments: &mut Vec<HistoryCompareSegment>, before: &str, after: &str) {
    let a: Vec<&str> = before.split_whitespace().collect();
    let b: Vec<&str> = after.split_whitespace().collect();
    if a.is_empty() && b.is_empty() {
        return;
    }
    if a.is_empty() {
        push_segment(segments, "add", after);
        return;
    }
    if b.is_empty() {
        push_segment(segments, "remove", before);
        return;
    }
    let n = a.len();
    let m = b.len();
    if n.saturating_mul(m) > 400_000 {
        push_segment(segments, "remove", before);
        push_segment(segments, "add", after);
        return;
    }
    let mut dp = vec![vec![0usize; m + 1]; n + 1];
    for i in 1..=n {
        for j in 1..=m {
            if a[i - 1] == b[j - 1] {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = dp[i - 1][j].max(dp[i][j - 1]);
            }
        }
    }
    let mut ops: Vec<(&str, &str)> = Vec::new();
    let mut i = n;
    let mut j = m;
    while i > 0 || j > 0 {
        if i > 0 && j > 0 && a[i - 1] == b[j - 1] {
            ops.push(("same", a[i - 1]));
            i -= 1;
            j -= 1;
        } else if i > 0 && (j == 0 || dp[i - 1][j] >= dp[i][j - 1]) {
            ops.push(("remove", a[i - 1]));
            i -= 1;
        } else {
            ops.push(("add", b[j - 1]));
            j -= 1;
        }
    }
    ops.reverse();
    for (kind, word) in ops {
        push_segment(segments, kind, word);
    }
}

fn push_segment(segments: &mut Vec<HistoryCompareSegment>, kind: &str, word: &str) {
    if let Some(last) = segments.last_mut() {
        if last.segment_kind == kind {
            last.text.push(' ');
            last.text.push_str(word);
            return;
        }
    }
    segments.push(HistoryCompareSegment {
        segment_kind: kind.into(),
        text: word.to_string(),
    });
}

fn storage_err(err: crate::storage::StorageError) -> DraftRepoError {
    DraftRepoError::Invalid(err.to_string())
}
