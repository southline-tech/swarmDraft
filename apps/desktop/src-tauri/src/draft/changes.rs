//! Change index (`review/changes.json`) and history lookup for one change id.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::manuscripts::{ReviewDecisionRecord, Suggestion};
use crate::storage::{StorageError, Store};

use super::repo::{message_trailers, trailer_value, trailer_values, DraftRepo, DraftRepoError};
use super::sync::{to_pretty, write_stable};

const QUOTE_CHARS: usize = 200;
const CHANGES_PATH: &str = "review/changes.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEntry {
    pub id: String,
    pub kind: String,
    pub section_id: String,
    pub author_kind: String,
    pub author_id: String,
    pub author_name: String,
    pub status: String,
    pub quote: String,
    /// Set when `status` is accepted or rejected. Omitted for an open change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "result")]
pub enum DraftChangeResolve {
    Found {
        change_id: String,
        status: String,
        section_id: String,
        introduced_commit: String,
        introduced_at: i64,
        introduced_ref: String,
        decided_commit: Option<String>,
        decided_at: Option<i64>,
        decision: Option<String>,
        session_id: Option<String>,
        present_in_head: bool,
    },
    NotFound {
        change_id: String,
    },
}

#[derive(Default)]
struct MarkAcc {
    saw_format: bool,
    saw_insert: bool,
    saw_delete: bool,
    author_kind: String,
    author_id: String,
    author_name: String,
    insert: String,
    delete: String,
    format: String,
}

pub fn clip_quote(text: &str) -> String {
    text.chars().take(QUOTE_CHARS).collect()
}

pub fn write_change_index(
    store: &Store,
    manuscript_id: &str,
    worktree: &Path,
) -> Result<(), DraftRepoError> {
    let changes = build_change_index(store, manuscript_id)?;
    let bytes = index_bytes(&changes)?;
    write_stable(&worktree.join("review").join("changes.json"), &bytes)
}

pub fn index_bytes(changes: &[ChangeEntry]) -> Result<Vec<u8>, DraftRepoError> {
    let mut ordered = changes.to_vec();
    ordered.sort_by(|a, b| a.id.cmp(&b.id));
    ordered.dedup_by(|a, b| a.id == b.id);
    to_pretty(&ordered)
}

/// Parse a change index. A file that is not JSON is an error (caller skips that commit).
/// Entries that are not objects with an id are dropped so one bad row is not fatal.
pub fn parse_change_index(bytes: &[u8]) -> Result<Vec<ChangeEntry>, ()> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| ())?;
    let Some(arr) = value.as_array() else {
        return Err(());
    };
    let mut out = Vec::new();
    for item in arr {
        let Ok(entry) = serde_json::from_value::<ChangeEntry>(item.clone()) else {
            continue;
        };
        if !entry.id.is_empty() {
            out.push(entry);
        }
    }
    Ok(out)
}

/// Change ids listed in one commit's `review/changes.json`. Empty when the file is missing.
pub(crate) fn change_ids_in_commit(
    repo: &DraftRepo,
    oid: &str,
) -> Result<HashSet<String>, DraftRepoError> {
    let Some(bytes) = repo.file_bytes(oid, CHANGES_PATH)? else {
        return Ok(HashSet::new());
    };
    Ok(parse_change_index(&bytes)
        .unwrap_or_default()
        .into_iter()
        .map(|entry| entry.id)
        .filter(|id| !id.is_empty())
        .collect())
}

pub fn build_change_index(
    store: &Store,
    manuscript_id: &str,
) -> Result<Vec<ChangeEntry>, DraftRepoError> {
    let sections = store.list_sections(manuscript_id).map_err(storage_err)?;
    let mut by_id: HashMap<String, ChangeEntry> = HashMap::new();

    for section in &sections {
        let doc = store.load_doc(&section.doc_id).map_err(storage_err)?;
        let mut marks: HashMap<String, MarkAcc> = HashMap::new();
        for block in crate::content::decode(&doc) {
            walk_marks(&block.node, &mut marks);
        }
        for (id, acc) in marks {
            let (kind, quote) = finalize_mark(&acc);
            by_id.insert(
                id.clone(),
                ChangeEntry {
                    id,
                    kind,
                    section_id: section.id.clone(),
                    author_kind: if acc.author_kind.is_empty() {
                        "human".into()
                    } else {
                        acc.author_kind
                    },
                    author_id: acc.author_id,
                    author_name: if acc.author_name.is_empty() {
                        "Author".into()
                    } else {
                        acc.author_name
                    },
                    status: "open".into(),
                    quote: clip_quote(&quote),
                    decided_by: None,
                    decided_at: None,
                },
            );
        }
    }

    for suggestion in store
        .suggestions_for_manuscript(manuscript_id)
        .map_err(storage_err)?
    {
        apply_suggestion(&mut by_id, &suggestion);
    }

    let decisions = store
        .review_decisions_for_manuscript(manuscript_id)
        .map_err(storage_err)?;
    for (section_id, records) in decisions {
        for record in records {
            apply_decision(&mut by_id, &section_id, &record);
        }
    }

    let mut changes: Vec<ChangeEntry> = by_id.into_values().collect();
    changes.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(changes)
}

fn apply_suggestion(by_id: &mut HashMap<String, ChangeEntry>, suggestion: &Suggestion) {
    let status = normalize_status(&suggestion.status);
    let kind = map_kind(&suggestion.kind);
    let quote = clip_quote(
        &suggestion
            .quote
            .clone()
            .filter(|q| !q.is_empty())
            .or_else(|| suggestion.replacement.clone())
            .unwrap_or_default(),
    );
    match by_id.get_mut(&suggestion.id) {
        Some(entry) => {
            if entry.kind.is_empty() {
                entry.kind = kind.into();
            }
            if entry.section_id.is_empty() {
                entry.section_id = suggestion.section_id.clone();
            }
            if !suggestion.author.kind.is_empty() {
                entry.author_kind = suggestion.author.kind.clone();
                entry.author_id = suggestion.author.id.clone();
                entry.author_name = suggestion.author.name.clone();
            }
            if entry.quote.is_empty() {
                entry.quote = quote;
            }
            if status != "open" {
                entry.status = status;
            }
        }
        None => {
            by_id.insert(
                suggestion.id.clone(),
                ChangeEntry {
                    id: suggestion.id.clone(),
                    kind: kind.into(),
                    section_id: suggestion.section_id.clone(),
                    author_kind: suggestion.author.kind.clone(),
                    author_id: suggestion.author.id.clone(),
                    author_name: suggestion.author.name.clone(),
                    status,
                    quote,
                    decided_by: None,
                    decided_at: None,
                },
            );
        }
    }
}

fn apply_decision(
    by_id: &mut HashMap<String, ChangeEntry>,
    section_id: &str,
    record: &ReviewDecisionRecord,
) {
    let status = normalize_status(&record.status);
    let decided_by = Some(record.decided_by.clone());
    let decided_at = Some(record.decided_at.clone());
    match by_id.get_mut(&record.id) {
        Some(entry) => {
            entry.status = status;
            entry.decided_by = decided_by;
            entry.decided_at = decided_at;
            if entry.section_id.is_empty() {
                entry.section_id = section_id.to_string();
            }
            // The decision row is the source of truth. A suggestion stub created
            // for the same id defaults to insert and must not hide accept vs reject kind.
            if !record.kind.is_empty() || entry.kind.is_empty() {
                entry.kind = map_kind(&record.kind).into();
            }
        }
        None => {
            by_id.insert(
                record.id.clone(),
                ChangeEntry {
                    id: record.id.clone(),
                    kind: map_kind(&record.kind).into(),
                    section_id: section_id.to_string(),
                    author_kind: "human".into(),
                    author_id: record.decided_by.clone(),
                    author_name: record.decided_by.clone(),
                    status,
                    quote: String::new(),
                    decided_by,
                    decided_at,
                },
            );
        }
    }
}

fn finalize_mark(acc: &MarkAcc) -> (String, String) {
    if acc.saw_format {
        let quote = if !acc.format.is_empty() {
            acc.format.clone()
        } else {
            acc.insert.clone()
        };
        return ("format_change".into(), quote);
    }
    if acc.saw_delete && !acc.saw_insert {
        return ("suggestion_delete".into(), acc.delete.clone());
    }
    let quote = if !acc.insert.is_empty() {
        acc.insert.clone()
    } else {
        acc.delete.clone()
    };
    ("suggestion_insert".into(), quote)
}

fn walk_marks(node: &Value, marks: &mut HashMap<String, MarkAcc>) {
    if node["type"] == "text" {
        let text = node["text"].as_str().unwrap_or("");
        if let Some(list) = node["marks"].as_array() {
            for mark in list {
                let kind = mark["type"].as_str().unwrap_or("");
                if !matches!(
                    kind,
                    "suggestion_insert" | "suggestion_delete" | "format_change"
                ) {
                    continue;
                }
                let id = mark["attrs"]["id"].as_str().unwrap_or("").trim();
                if id.is_empty() {
                    continue;
                }
                let acc = marks.entry(id.to_string()).or_default();
                match kind {
                    "suggestion_insert" => {
                        acc.saw_insert = true;
                        acc.insert.push_str(text);
                    }
                    "suggestion_delete" => {
                        acc.saw_delete = true;
                        acc.delete.push_str(text);
                    }
                    "format_change" => {
                        acc.saw_format = true;
                        if acc.format.is_empty() {
                            acc.format = format_summary(text, &mark["attrs"]);
                        } else if !text.is_empty() {
                            acc.format.push_str(text);
                        }
                    }
                    _ => {}
                }
                if acc.author_id.is_empty() {
                    let (k, id, name) =
                        author_parts(mark["attrs"]["author"].as_str().unwrap_or(""));
                    acc.author_kind = k;
                    acc.author_id = id;
                    acc.author_name = name;
                }
            }
        }
    }
    if let Some(children) = node["content"].as_array() {
        for child in children {
            walk_marks(child, marks);
        }
    }
}

fn format_summary(text: &str, attrs: &Value) -> String {
    let before = attrs["before"].as_str().unwrap_or("");
    let after = attrs["after"].as_str().unwrap_or("");
    let target = attrs["target"].as_str().unwrap_or("");
    if !before.is_empty() || !after.is_empty() {
        format!("{before} → {after}")
    } else if !text.is_empty() {
        text.to_string()
    } else {
        target.to_string()
    }
}

fn author_parts(author: &str) -> (String, String, String) {
    let author = author.trim();
    if let Some(rest) = author.strip_prefix("agent:") {
        let id = if rest.is_empty() {
            author.to_string()
        } else {
            rest.to_string()
        };
        ("agent".into(), id, author.to_string())
    } else if author.is_empty() {
        ("human".into(), "local".into(), "Author".into())
    } else {
        ("human".into(), author.to_string(), author.to_string())
    }
}

pub(crate) fn map_kind(kind: &str) -> &'static str {
    match kind {
        "delete" | "suggestion_delete" => "suggestion_delete",
        "style" | "format_change" => "format_change",
        _ => "suggestion_insert",
    }
}

fn normalize_status(status: &str) -> String {
    match status {
        "accepted" => "accepted".into(),
        "rejected" => "rejected".into(),
        _ => "open".into(),
    }
}

struct Intro {
    commit: String,
    at: i64,
    reference: String,
    status: String,
    section_id: String,
    session_id: Option<String>,
}

struct DecisionHit {
    commit: String,
    at: i64,
    decision: String,
    session_id: Option<String>,
}

/// Cache key for change lookup. Includes every searched tip so a bot or session
/// commit invalidates a result that was cached while `main` stayed put.
pub fn tip_cache_key(repo: &DraftRepo) -> Result<String, DraftRepoError> {
    let tips = repo.search_ref_tips()?;
    Ok(tips
        .into_iter()
        .map(|tip| format!("{} {}", tip.name, tip.oid))
        .collect::<Vec<_>>()
        .join("\n"))
}

/// Every change id found in history. Unknown ids are simply absent.
/// The introducing commit is the earliest one that adds the id. A later snapshot
/// that lists the same id does not replace it. A `review/changes.json` that does
/// not parse is skipped. Each ref walk stops at a commit already seen, so session
/// refs that point at `main` history are not walked again.
pub fn resolve_all(
    repo: &DraftRepo,
) -> Result<HashMap<String, DraftChangeResolve>, DraftRepoError> {
    let head = repo.head_oid()?.unwrap_or_default();
    let head_entries = if head.is_empty() {
        Vec::new()
    } else {
        match repo.file_bytes(&head, CHANGES_PATH)? {
            Some(bytes) => parse_change_index(&bytes).unwrap_or_default(),
            None => Vec::new(),
        }
    };
    let head_by_id: HashMap<String, ChangeEntry> = head_entries
        .into_iter()
        .map(|e| (e.id.clone(), e))
        .collect();

    let mut intro: HashMap<String, Intro> = HashMap::new();
    let mut decided: HashMap<String, DecisionHit> = HashMap::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut index_cache: HashMap<String, Vec<ChangeEntry>> = HashMap::new();

    for tip in repo.search_ref_tips()? {
        if !seen.insert(tip.oid.clone()) {
            continue;
        }
        let mut oid = tip.oid;
        loop {
            let commit = repo.history_commit(&oid)?;
            let trailers = message_trailers(&commit.message);
            let session = trailer_value(&trailers, "Session");
            let decisions = trailer_values(&trailers, "Decision");
            for (index, id) in trailer_values(&trailers, "Change-Id")
                .into_iter()
                .enumerate()
            {
                if id.is_empty() {
                    continue;
                }
                let decision = decisions
                    .get(index)
                    .or_else(|| decisions.last())
                    .cloned()
                    .unwrap_or_default();
                let replace = decided
                    .get(&id)
                    .map(|hit| commit.time_unix > hit.at)
                    .unwrap_or(true);
                if replace {
                    decided.insert(
                        id,
                        DecisionHit {
                            commit: commit.oid.clone(),
                            at: commit.time_unix,
                            decision,
                            session_id: session.clone(),
                        },
                    );
                }
            }
            let parent = repo.parent_oid(&oid)?;
            let parent_ids = match &parent {
                Some(parent_oid) => change_id_set(repo, parent_oid, &mut index_cache)?,
                None => HashSet::new(),
            };
            for entry in change_entries_at(repo, &oid, &mut index_cache)? {
                if parent_ids.contains(&entry.id) {
                    continue;
                }
                let replace = match intro.get(&entry.id) {
                    Some(prev) => {
                        intro_beats(commit.time_unix, &tip.name, prev.at, &prev.reference)
                    }
                    None => true,
                };
                if replace {
                    intro.insert(
                        entry.id.clone(),
                        Intro {
                            commit: commit.oid.clone(),
                            at: commit.time_unix,
                            reference: tip.name.clone(),
                            status: entry.status,
                            section_id: entry.section_id,
                            session_id: session.clone(),
                        },
                    );
                }
            }
            let Some(parent_oid) = parent else {
                break;
            };
            if !seen.insert(parent_oid.clone()) {
                break;
            }
            oid = parent_oid;
        }
    }

    let mut out = HashMap::new();
    for (id, found) in intro {
        let head_entry = head_by_id.get(&id);
        let decision = decided.get(&id);
        let status = if let Some(entry) = head_entry {
            entry.status.clone()
        } else if let Some(hit) = decision {
            if hit.decision == "accepted" || hit.decision == "rejected" {
                hit.decision.clone()
            } else {
                found.status.clone()
            }
        } else {
            found.status.clone()
        };
        let section_id = head_entry
            .map(|e| e.section_id.clone())
            .filter(|s| !s.is_empty())
            .unwrap_or(found.section_id);
        let session_id = decision
            .and_then(|d| d.session_id.clone())
            .or(found.session_id);
        let present_in_head = head_entry.is_some();
        out.insert(
            id.clone(),
            DraftChangeResolve::Found {
                change_id: id,
                status,
                section_id,
                introduced_commit: found.commit,
                introduced_at: found.at,
                introduced_ref: found.reference,
                decided_commit: decision.map(|d| d.commit.clone()),
                decided_at: decision.map(|d| d.at),
                decision: decision.and_then(|d| {
                    if d.decision.is_empty() {
                        None
                    } else {
                        Some(d.decision.clone())
                    }
                }),
                session_id,
                present_in_head,
            },
        );
    }
    Ok(out)
}

fn change_entries_at(
    repo: &DraftRepo,
    oid: &str,
    cache: &mut HashMap<String, Vec<ChangeEntry>>,
) -> Result<Vec<ChangeEntry>, DraftRepoError> {
    if let Some(entries) = cache.get(oid) {
        return Ok(entries.clone());
    }
    let entries = match repo.file_bytes(oid, CHANGES_PATH)? {
        Some(bytes) => parse_change_index(&bytes).unwrap_or_default(),
        None => Vec::new(),
    };
    cache.insert(oid.to_string(), entries.clone());
    Ok(entries)
}

fn change_id_set(
    repo: &DraftRepo,
    oid: &str,
    cache: &mut HashMap<String, Vec<ChangeEntry>>,
) -> Result<HashSet<String>, DraftRepoError> {
    Ok(change_entries_at(repo, oid, cache)?
        .into_iter()
        .map(|entry| entry.id)
        .collect())
}

/// Earlier commit wins. The same timestamp prefers the bot ref, then `main`.
fn intro_beats(new_at: i64, new_ref: &str, old_at: i64, old_ref: &str) -> bool {
    new_at < old_at || (new_at == old_at && ref_rank(new_ref) < ref_rank(old_ref))
}

fn ref_rank(name: &str) -> u8 {
    if name.starts_with("bot/") {
        0
    } else if name == "main" || name == "master" {
        1
    } else {
        2
    }
}

fn storage_err(e: StorageError) -> DraftRepoError {
    DraftRepoError::Invalid(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, quote: &str) -> ChangeEntry {
        ChangeEntry {
            id: id.into(),
            kind: "suggestion_insert".into(),
            section_id: "sec".into(),
            author_kind: "human".into(),
            author_id: "local".into(),
            author_name: "Author".into(),
            status: "open".into(),
            quote: quote.into(),
            decided_by: None,
            decided_at: None,
        }
    }

    #[test]
    fn quote_clips_to_200_chars() {
        let long: String = "é".repeat(250);
        assert_eq!(clip_quote(&long).chars().count(), 200);
    }

    #[test]
    fn index_bytes_stable_and_sorted() {
        let first = index_bytes(&[entry("b", "one"), entry("a", "two")]).unwrap();
        let second = index_bytes(&[entry("a", "two"), entry("b", "one")]).unwrap();
        assert_eq!(first, second);
        let text = String::from_utf8(first).unwrap();
        assert!(text.find("\"id\": \"a\"").unwrap() < text.find("\"id\": \"b\"").unwrap());
    }

    #[test]
    fn corrupt_index_is_an_error_and_bad_rows_are_dropped() {
        assert!(parse_change_index(b"{not json").is_err());
        assert!(parse_change_index(br#"{"changes":[]}"#).is_err());
        let parsed = parse_change_index(
            br#"[{"id":"ok","kind":"suggestion_insert","sectionId":"s","authorKind":"human","authorId":"a","authorName":"A","status":"open","quote":"q"}, {"nope":true}]"#,
        )
        .unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].id, "ok");
    }
}
