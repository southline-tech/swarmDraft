//! Deep links to a tracked change (`swarmdraft://open?draft=&change=`).
//!
//! Resolution goes through [`draft::DraftService::resolve_change`] (git history) only after the
//! manuscript id is one path segment and an existing row. Anything else is the unknown result
//! and does not open or create a repo.

use std::path::{Component, Path};
use std::sync::Mutex;

use serde::Serialize;

use crate::draft::{DraftChangeResolve, DraftRepo, DraftService};
use crate::storage::{StorageError, Store};

const SCHEME: &str = "swarmdraft://";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangeLink {
    pub manuscript_id: String,
    pub change_id: String,
}

/// `swarmdraft://open?draft=<manuscriptId>&change=<changeId>`.
pub fn encode_change_link(manuscript_id: &str, change_id: &str) -> String {
    format!(
        "swarmdraft://open?draft={}&change={}",
        percent_encode(manuscript_id),
        percent_encode(change_id)
    )
}

/// Parse a change link. Anything else (wrong scheme, missing id, blank id) is `None`.
pub fn parse_change_link(raw: &str) -> Option<ChangeLink> {
    let raw = raw.trim();
    let rest = strip_prefix_ignore_ascii_case(raw, SCHEME)?;
    let (host, query) = rest.split_once('?')?;
    let host = host.trim_end_matches('/');
    if !host.eq_ignore_ascii_case("open") {
        return None;
    }
    let query = query.split('#').next().unwrap_or(query);
    let mut manuscript_id = None;
    let mut change_id = None;
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let value = percent_decode(value).trim().to_string();
        if value.is_empty() {
            continue;
        }
        match key {
            "draft" => manuscript_id = Some(value),
            "change" => change_id = Some(value),
            _ => {}
        }
    }
    Some(ChangeLink {
        manuscript_id: manuscript_id?,
        change_id: change_id?,
    })
}

/// First argv entry that is a change link, in any position.
pub fn first_change_link(argv: &[String]) -> Option<String> {
    argv.iter().find_map(|arg| {
        let text = arg.trim();
        parse_change_link(text).map(|_| text.to_string())
    })
}

/// Remembers the cold-start URL so the webview can take it once.
#[derive(Default)]
pub struct LaunchGate(Mutex<Option<String>>);

impl LaunchGate {
    /// Return `url` the first time it is seen. The same URL after that is `None`.
    pub fn take(&self, url: String) -> Option<String> {
        let mut slot = self.0.lock().ok()?;
        if slot.as_deref() == Some(url.as_str()) {
            return None;
        }
        *slot = Some(url.clone());
        Some(url)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChangeLinkClass {
    /// Still on the page. `section_id` is the current section, including after a move.
    Focus {
        section_id: String,
        change_id: String,
    },
    History {
        change_id: String,
        section_id: String,
        outcome: String,
        decided_at: Option<i64>,
        decided_commit: Option<String>,
        introduced_commit: String,
    },
    Unknown,
}

/// Map a git-history lookup to a focus target or a read-only history view.
pub fn classify_change(resolve: &DraftChangeResolve) -> ChangeLinkClass {
    match resolve {
        DraftChangeResolve::NotFound { .. } => ChangeLinkClass::Unknown,
        DraftChangeResolve::Found {
            change_id,
            status,
            section_id,
            introduced_commit,
            decided_commit,
            decided_at,
            decision,
            present_in_head,
            ..
        } => {
            let outcome = decision
                .clone()
                .filter(|d| !d.is_empty())
                .unwrap_or_else(|| status.clone());
            let settled = outcome == "accepted"
                || outcome == "rejected"
                || status == "accepted"
                || status == "rejected";
            if settled {
                let outcome = if outcome == "accepted" || outcome == "rejected" {
                    outcome
                } else {
                    status.clone()
                };
                return ChangeLinkClass::History {
                    change_id: change_id.clone(),
                    section_id: section_id.clone(),
                    outcome,
                    decided_at: *decided_at,
                    decided_commit: decided_commit.clone(),
                    introduced_commit: introduced_commit.clone(),
                };
            }
            if *present_in_head {
                return ChangeLinkClass::Focus {
                    section_id: section_id.clone(),
                    change_id: change_id.clone(),
                };
            }
            ChangeLinkClass::History {
                change_id: change_id.clone(),
                section_id: section_id.clone(),
                outcome: if outcome.is_empty() {
                    "recorded".into()
                } else {
                    outcome
                },
                decided_at: *decided_at,
                decided_commit: decided_commit.clone(),
                introduced_commit: introduced_commit.clone(),
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangeSnapshot {
    pub id: String,
    pub kind: String,
    pub section_id: String,
    pub author_kind: String,
    pub author_name: String,
    pub status: String,
    pub quote: String,
}

pub fn read_change_snapshot(
    repo: &DraftRepo,
    oid: &str,
    change_id: &str,
) -> Option<ChangeSnapshot> {
    let bytes = repo.file_bytes(oid, "review/changes.json").ok()??;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let arr = value.as_array()?;
    for item in arr {
        let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if id != change_id {
            continue;
        }
        return Some(ChangeSnapshot {
            id: id.to_string(),
            kind: json_str(item, "kind"),
            section_id: json_str(item, "sectionId"),
            author_kind: json_str(item, "authorKind"),
            author_name: json_str(item, "authorName"),
            status: json_str(item, "status"),
            quote: json_str(item, "quote"),
        });
    }
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryView {
    pub quote: String,
    pub kind: String,
    pub author_kind: String,
    pub author_name: String,
    pub outcome: String,
    pub decided_by: String,
    pub decided_at: Option<i64>,
}

/// Original wording from the introducing commit, and who decided it.
///
/// `decided_by` is the `Decided-By` trailer (the writer's display name). The review
/// commit's git committer is the bot and is not shown.
pub fn load_history_view(
    repo: &DraftRepo,
    change_id: &str,
    introduced_commit: &str,
    decided_commit: Option<&str>,
    outcome: &str,
    decided_at: Option<i64>,
) -> HistoryView {
    let snap = read_change_snapshot(repo, introduced_commit, change_id);
    let mut kind = snap.as_ref().map(|s| s.kind.clone()).unwrap_or_default();
    let quote = snap.as_ref().map(|s| s.quote.clone()).unwrap_or_default();
    let author_name = snap
        .as_ref()
        .map(|s| s.author_name.clone())
        .unwrap_or_default();
    let mut author_kind = snap
        .as_ref()
        .map(|s| s.author_kind.clone())
        .unwrap_or_default();
    if kind.is_empty() {
        if let Some(oid) = decided_commit {
            if let Ok(message) = repo.commit_message(oid) {
                if let Some(from_trailer) = trailer(&message, "Kind") {
                    kind = from_trailer;
                }
            }
        }
    }
    if agent_id_from_mark(&author_name).is_some() {
        author_kind = "agent".into();
    }
    let decided_by = decided_commit
        .and_then(|oid| repo.commit_message(oid).ok())
        .and_then(|message| trailer(&message, "Decided-By"))
        .unwrap_or_default();
    HistoryView {
        quote,
        kind,
        author_kind,
        author_name,
        outcome: outcome.to_string(),
        decided_by,
        decided_at,
    }
}

/// `agent:<id>` as stored on a review mark. Anything else is not a raw agent id.
fn agent_id_from_mark(author_name: &str) -> Option<&str> {
    let id = author_name.trim().strip_prefix("agent:")?.trim();
    if id.is_empty() {
        None
    } else {
        Some(id)
    }
}

fn usable_saved_name(name: &str, agent_id: &str) -> Option<String> {
    let name = name.trim();
    if name.is_empty() || name.starts_with("agent:") || name == agent_id {
        return None;
    }
    Some(name.to_string())
}

/// Display name saved with the suggestion, then the agent's saved name.
/// `author_parts` keeps `agent:<id>` on the snapshot unless a suggestion row replaced it.
fn saved_bot_display_name(
    store: &Store,
    manuscript_id: &str,
    change_id: &str,
    agent_id: &str,
) -> Option<String> {
    if let Ok(rows) = store.suggestions_for_manuscript(manuscript_id) {
        if let Some(row) = rows.iter().find(|s| s.id == change_id) {
            if let Some(name) = usable_saved_name(&row.author.name, agent_id) {
                return Some(name);
            }
        }
        if let Some(row) = rows
            .iter()
            .find(|s| s.author.kind == "agent" && s.author.id == agent_id)
        {
            if let Some(name) = usable_saved_name(&row.author.name, agent_id) {
                return Some(name);
            }
        }
    }
    let agents = store.list_agents().ok()?;
    let agent = agents.iter().find(|a| a.id == agent_id)?;
    usable_saved_name(&agent.name, agent_id)
}

fn resolve_saved_author(
    store: &Store,
    manuscript_id: &str,
    change_id: &str,
    author_name: &str,
    author_kind: &str,
) -> (String, String) {
    let Some(agent_id) = agent_id_from_mark(author_name) else {
        return (author_name.to_string(), author_kind.to_string());
    };
    let name =
        saved_bot_display_name(store, manuscript_id, change_id, agent_id).unwrap_or_default();
    (name, "agent".into())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "action")]
pub enum LinkResolution {
    Focus {
        manuscript_id: String,
        section_id: String,
        change_id: String,
    },
    History {
        manuscript_id: String,
        change_id: String,
        section_id: String,
        quote: String,
        kind: String,
        author_kind: String,
        author_name: String,
        outcome: String,
        decided_by: String,
        decided_at: Option<i64>,
    },
    Unknown {
        manuscript_id: String,
    },
}

/// One path segment: not absolute, not `.` or `..`, and no separator.
/// `Path::join` would otherwise replace the data directory or walk out of it.
fn manuscript_id_is_single_segment(id: &str) -> bool {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains('\0') {
        return false;
    }
    let mut components = Path::new(id).components();
    let Some(component) = components.next() else {
        return false;
    };
    if components.next().is_some() {
        return false;
    }
    match component {
        Component::Normal(part) => part != "." && part != "..",
        _ => false,
    }
}

/// Resolve one change link through git history.
///
/// A missing row or an id that is not a single path segment is [`LinkResolution::Unknown`]
/// and does not call [`DraftService::resolve_change`], which would create a repo.
pub fn resolve_open_link(
    drafts: &DraftService,
    store: &Store,
    manuscript_id: &str,
    change_id: &str,
) -> Result<LinkResolution, String> {
    if !manuscript_id_is_single_segment(manuscript_id) {
        return Ok(LinkResolution::Unknown {
            manuscript_id: manuscript_id.to_string(),
        });
    }
    match store.get_manuscript(manuscript_id) {
        Ok(_) => {}
        Err(StorageError::NotFound(_)) => {
            return Ok(LinkResolution::Unknown {
                manuscript_id: manuscript_id.to_string(),
            });
        }
        Err(err) => return Err(err.to_string()),
    }
    let resolved = drafts.resolve_change(store, manuscript_id, change_id)?;
    Ok(resolution_from(drafts, store, manuscript_id, &resolved))
}

fn resolution_from(
    drafts: &DraftService,
    store: &Store,
    manuscript_id: &str,
    resolved: &DraftChangeResolve,
) -> LinkResolution {
    match classify_change(resolved) {
        ChangeLinkClass::Unknown => LinkResolution::Unknown {
            manuscript_id: manuscript_id.to_string(),
        },
        ChangeLinkClass::Focus {
            section_id,
            change_id,
        } => LinkResolution::Focus {
            manuscript_id: manuscript_id.to_string(),
            section_id,
            change_id,
        },
        ChangeLinkClass::History {
            change_id,
            section_id,
            outcome,
            decided_at,
            decided_commit,
            introduced_commit,
        } => {
            let dir = drafts.worktree_path(manuscript_id);
            let view = DraftRepo::open_working(&dir)
                .ok()
                .map(|repo| {
                    load_history_view(
                        &repo,
                        &change_id,
                        &introduced_commit,
                        decided_commit.as_deref(),
                        &outcome,
                        decided_at,
                    )
                })
                .unwrap_or(HistoryView {
                    quote: String::new(),
                    kind: String::new(),
                    author_kind: String::new(),
                    author_name: String::new(),
                    outcome: outcome.clone(),
                    decided_by: String::new(),
                    decided_at,
                });
            let (author_name, author_kind) = resolve_saved_author(
                store,
                manuscript_id,
                &change_id,
                &view.author_name,
                &view.author_kind,
            );
            LinkResolution::History {
                manuscript_id: manuscript_id.to_string(),
                change_id,
                section_id,
                quote: view.quote,
                kind: view.kind,
                author_kind,
                author_name,
                outcome: view.outcome,
                decided_by: view.decided_by,
                decided_at: view.decided_at,
            }
        }
    }
}

fn json_str(item: &serde_json::Value, key: &str) -> String {
    item.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn trailer(message: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    for line in message.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some(rest) = line.strip_prefix(&prefix) else {
            continue;
        };
        let value = rest.trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

fn strip_prefix_ignore_ascii_case<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    if text.len() < prefix.len() {
        return None;
    }
    let (head, tail) = text.split_at(prefix.len());
    if head.eq_ignore_ascii_case(prefix) {
        Some(tail)
    } else {
        None
    }
}

fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for b in text.as_bytes() {
        match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(*b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(value) = u8::from_str_radix(hex, 16) {
                    out.push(value);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::draft::CommitOptions;

    fn found(
        status: &str,
        section_id: &str,
        decision: Option<&str>,
        present_in_head: bool,
    ) -> DraftChangeResolve {
        DraftChangeResolve::Found {
            change_id: "chg-1".into(),
            status: status.into(),
            section_id: section_id.into(),
            introduced_commit: "intro".into(),
            introduced_at: 10,
            introduced_ref: "main".into(),
            decided_commit: decision.map(|_| "decided".into()),
            decided_at: decision.map(|_| 20),
            decision: decision.map(str::to_string),
            session_id: None,
            present_in_head,
        }
    }

    #[test]
    fn link_round_trip_and_malformed_links() {
        let url = encode_change_link("ms 1", "chg/1");
        assert_eq!(url, "swarmdraft://open?draft=ms%201&change=chg%2F1");
        assert_eq!(
            parse_change_link(&url),
            Some(ChangeLink {
                manuscript_id: "ms 1".into(),
                change_id: "chg/1".into(),
            })
        );
        assert_eq!(
            parse_change_link("swarmdraft://open/?draft=ms&change=chg"),
            Some(ChangeLink {
                manuscript_id: "ms".into(),
                change_id: "chg".into(),
            })
        );
        assert!(parse_change_link("https://example.com/?draft=ms&change=chg").is_none());
        assert!(parse_change_link("swarmdraft://open?draft=ms").is_none());
        assert!(parse_change_link("swarmdraft://open?draft=&change=chg").is_none());
        assert!(parse_change_link("swarmdraft://other?draft=ms&change=chg").is_none());
        assert!(parse_change_link("not a link").is_none());
    }

    #[test]
    fn argv_finds_a_change_link_beside_other_args() {
        let argv = vec![
            "swarmdraft".into(),
            "--flag".into(),
            "swarmdraft://open?draft=book&change=chg-9".into(),
        ];
        assert_eq!(
            first_change_link(&argv).as_deref(),
            Some("swarmdraft://open?draft=book&change=chg-9")
        );
    }

    #[test]
    fn live_change_focuses_its_section() {
        match classify_change(&found("open", "sec-1", None, true)) {
            ChangeLinkClass::Focus {
                section_id,
                change_id,
            } => {
                assert_eq!(section_id, "sec-1");
                assert_eq!(change_id, "chg-1");
            }
            other => panic!("expected focus, got {other:?}"),
        }
    }

    #[test]
    fn moved_change_focuses_the_resolved_section() {
        // The introducing snapshot lived in another section. The resolve result's
        // section id is the current one, and that is where the link opens.
        match classify_change(&found("open", "sec-new", None, true)) {
            ChangeLinkClass::Focus { section_id, .. } => assert_eq!(section_id, "sec-new"),
            other => panic!("expected focus at the new section, got {other:?}"),
        }
    }

    #[test]
    fn accepted_and_rejected_changes_are_history() {
        match classify_change(&found("accepted", "sec-1", Some("accepted"), false)) {
            ChangeLinkClass::History { outcome, .. } => assert_eq!(outcome, "accepted"),
            other => panic!("expected history, got {other:?}"),
        }
        match classify_change(&found("rejected", "sec-1", Some("rejected"), false)) {
            ChangeLinkClass::History {
                outcome,
                decided_at,
                ..
            } => {
                assert_eq!(outcome, "rejected");
                assert_eq!(decided_at, Some(20));
            }
            other => panic!("expected history, got {other:?}"),
        }
    }

    #[test]
    fn unknown_id_is_not_a_page() {
        let missing = DraftChangeResolve::NotFound {
            change_id: "nope".into(),
        };
        assert_eq!(classify_change(&missing), ChangeLinkClass::Unknown);
    }

    #[test]
    fn traversal_and_unknown_ids_do_not_create_a_repo() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let drafts = DraftService::new(dir.path().to_path_buf(), "0.0.0".into());
        let outside = tempfile::tempdir().unwrap();
        let escaped = outside.path().join("from-link");
        let ids = [
            "..".to_string(),
            ".".to_string(),
            escaped.to_string_lossy().into_owned(),
            "../../tmp/evil".to_string(),
            "a/b".to_string(),
            r"a\b".to_string(),
        ];
        for id in &ids {
            let result = resolve_open_link(&drafts, &store, id, "chg").unwrap();
            assert!(
                matches!(result, LinkResolution::Unknown { .. }),
                "{id} -> {result:?}"
            );
        }
        assert!(!dir.path().join(".git").exists());
        assert!(!dir.path().join("draft-repos").exists());
        assert!(!escaped.exists());

        let unknown = resolve_open_link(&drafts, &store, "not-a-book", "chg").unwrap();
        assert_eq!(
            unknown,
            LinkResolution::Unknown {
                manuscript_id: "not-a-book".into(),
            }
        );
        assert!(!dir.path().join("draft-repos").join("not-a-book").exists());

        let created = store.create_manuscript("Book").unwrap();
        let missing = resolve_open_link(&drafts, &store, &created.id, "no-such-change").unwrap();
        assert!(matches!(missing, LinkResolution::Unknown { .. }));
        let repo = dir.path().join("draft-repos").join(&created.id);
        assert!(repo.starts_with(dir.path()));
        assert!(repo.join(".git").is_dir());
    }

    #[test]
    fn launch_gate_returns_a_url_once() {
        let gate = LaunchGate::default();
        let url = "swarmdraft://open?draft=m&change=c".to_string();
        assert_eq!(gate.take(url.clone()).as_deref(), Some(url.as_str()));
        assert_eq!(gate.take(url), None);
    }

    #[test]
    fn history_keeps_the_original_quote_and_the_decision() {
        let dir = tempfile::tempdir().unwrap();
        let repo = DraftRepo::init_working(dir.path()).unwrap();
        std::fs::create_dir(dir.path().join("review")).unwrap();
        let introduced = serde_json::json!([{
            "id": "chg-1",
            "kind": "suggestion_insert",
            "sectionId": "sec-old",
            "authorKind": "human",
            "authorId": "local",
            "authorName": "Ada",
            "status": "open",
            "quote": "guttered"
        }]);
        std::fs::write(
            dir.path().join("review/changes.json"),
            serde_json::to_vec_pretty(&introduced).unwrap(),
        )
        .unwrap();
        let introduced_oid = repo
            .commit_all(
                "Introduce change",
                "Ada",
                "ada@example.com",
                &CommitOptions::default(),
            )
            .unwrap()
            .unwrap();

        let moved = serde_json::json!([{
            "id": "chg-1",
            "kind": "suggestion_insert",
            "sectionId": "sec-new",
            "authorKind": "human",
            "authorId": "local",
            "authorName": "Ada",
            "status": "open",
            "quote": "guttered"
        }]);
        std::fs::write(
            dir.path().join("review/changes.json"),
            serde_json::to_vec_pretty(&moved).unwrap(),
        )
        .unwrap();
        repo.commit_all(
            "Move change",
            "Ada",
            "ada@example.com",
            &CommitOptions::default(),
        )
        .unwrap()
        .unwrap();
        let head = repo.head_oid().unwrap().unwrap();
        let live = read_change_snapshot(&repo, &head, "chg-1").unwrap();
        assert_eq!(live.section_id, "sec-new");

        let accepted = serde_json::json!([{
            "id": "chg-1",
            "kind": "suggestion_insert",
            "sectionId": "sec-new",
            "authorKind": "human",
            "authorId": "local",
            "authorName": "Ada",
            "status": "accepted",
            "quote": ""
        }]);
        std::fs::write(
            dir.path().join("review/changes.json"),
            serde_json::to_vec_pretty(&accepted).unwrap(),
        )
        .unwrap();
        let decided = repo
            .commit_all(
                "Accepted Ada's change in Chapter\n\nChange-Id: chg-1\nDecision: accepted\nKind: suggestion_insert\nDecided-By: Sam\n",
                "agent:bot-1",
                "bot@example.com",
                &CommitOptions::default(),
            )
            .unwrap()
            .unwrap();
        let view = load_history_view(
            &repo,
            "chg-1",
            &introduced_oid,
            Some(&decided),
            "accepted",
            Some(20),
        );
        assert_eq!(view.quote, "guttered");
        assert_eq!(view.kind, "suggestion_insert");
        assert_eq!(view.author_kind, "human");
        assert_eq!(view.author_name, "Ada");
        assert_eq!(view.outcome, "accepted");
        assert_eq!(view.decided_by, "Sam");
        assert_eq!(view.decided_at, Some(20));
    }

    /// Decision commit for `chg-1`: the bot branch tip, or a merge parent of main.
    fn decision_on_bot_or_merged(repo: &DraftRepo) -> (String, String) {
        let mut oids = Vec::new();
        for tip in repo.search_ref_tips().unwrap() {
            oids.push(tip.oid);
        }
        let mut seen = std::collections::HashSet::new();
        while let Some(oid) = oids.pop() {
            if !seen.insert(oid.clone()) {
                continue;
            }
            let message = repo.commit_message(&oid).unwrap();
            if message.contains("Change-Id: chg-1") && message.contains("Decided-By: Sam") {
                return (oid, message);
            }
            if let Ok(parents) = repo.parent_oids(&oid) {
                oids.extend(parents);
            }
        }
        panic!("decision commit not on a bot branch or in merged history");
    }

    #[test]
    fn accepted_link_names_the_writer_and_the_bots_saved_name() {
        use crate::content;
        use crate::storage::Store;
        use yrs::{ReadTxn, StateVector, Transact};

        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        store.set_user_display_name("Sam").unwrap();
        let writer = store.user_display_name().unwrap().unwrap();
        let agent = store.create_agent("Line Editor", "#3366ff").unwrap();
        let stored = store.create_blank_manuscript_with_progress(None).unwrap();
        let manuscript_id = stored.manuscript.id.clone();
        let chapter = stored
            .sections
            .iter()
            .find(|s| s.section.kind == "chapter")
            .unwrap();
        let section_id = chapter.section.id.clone();
        let mark_author = format!("agent:{}", agent.id);
        let doc = content::new_doc();
        content::encode(
            &doc,
            &serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[{
                "type":"text",
                "text": "guttered",
                "marks":[{"type":"suggestion_insert","attrs":{"id": "chg-1", "author": mark_author, "ts":"t"}}]
            }]}]}),
        )
        .unwrap();
        let state = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        store
            .replace_doc_state(&chapter.section.doc_id, &state)
            .unwrap();
        let path = store.data_dir().join("drafts").join("book.draft");
        store
            .set_draft_file_path(&manuscript_id, &path.to_string_lossy())
            .unwrap();
        let drafts = DraftService::new(dir.path().to_path_buf(), "0.2.2".into());
        drafts
            .commit_review_decision(
                &store,
                &manuscript_id,
                true,
                &mark_author,
                chapter.section.title.as_str(),
                &writer,
                Some(agent.id.as_str()),
                Some("chg-1"),
                Some("suggestion_insert"),
                Some(section_id.as_str()),
            )
            .unwrap()
            .expect("decision commit");

        let repo = DraftRepo::open_working(&drafts.worktree_path(&manuscript_id)).unwrap();
        // The decision is a commit on `bot/<bot>/<session>`, including when that
        // commit is only a parent of the merge on main. Main's tip is the checkpoint
        // or the merge, and its message is not the decision.
        let (decided, message) = decision_on_bot_or_merged(&repo);
        assert!(message.contains("Decided-By: Sam"), "{message}");
        let git = git2::Repository::open(drafts.worktree_path(&manuscript_id)).unwrap();
        let committer = git
            .find_commit(git2::Oid::from_str(&decided).unwrap())
            .unwrap()
            .committer()
            .name()
            .unwrap()
            .to_string();
        assert_eq!(committer, mark_author);

        let resolved = resolve_open_link(&drafts, &store, &manuscript_id, "chg-1").unwrap();
        let LinkResolution::History {
            decided_by,
            author_name,
            author_kind,
            quote,
            outcome,
            ..
        } = resolved
        else {
            panic!("expected history, got {resolved:?}");
        };
        let summary = format!("{decided_by} accepted {author_name}'s change");
        assert_eq!(outcome, "accepted");
        assert_eq!(quote, "guttered");
        assert_eq!(author_kind, "agent");
        assert_eq!(summary, "Sam accepted Line Editor's change");
        assert!(!summary.contains("agent:"));
        assert_ne!(decided_by, committer);
    }
}
