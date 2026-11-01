//! Agent identity (RAD-205): agent principals and per-agent bearer tokens.
//!
//! - A token is `cat_` + 32 random bytes (base64url). It is returned once at creation and only its
//!   SHA-256 hash is stored; the token has 256 bits of entropy, so a slow KDF is not needed.
//! - Scopes are a subset of `read`, `comment`, `suggest` (default: all three). There is no scope
//!   for deciding suggestions: accept/reject is human-only and never reachable by an agent.
//! - Revocation (of a token or a whole agent) is checked on every authentication, so a revoked
//!   token fails on its next request.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use crate::storage::{StorageError, Store};

pub const TOKEN_PREFIX: &str = "cat_";
pub const SCOPES: &[&str] = &["read", "comment", "suggest"];
/// Name pre-filled in Settings → Agents; the P1 agent.
pub const DEFAULT_AGENT_NAME: &str = "Grok Bot";

const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub color: String,
    pub created_at: String,
    pub revoked_at: Option<String>,
    /// Built-in P1 bot; at most one row is primary. Drives a fixed collab-1 color by agent id.
    pub primary: bool,
    /// Last authenticated MCP activity (#188); throttled writes.
    pub last_seen_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenInfo {
    pub id: String,
    pub agent_id: String,
    /// First characters of the token, so the owner can tell tokens apart.
    pub prefix: String,
    pub scopes: Vec<String>,
    pub created_at: String,
    pub last_used_at: Option<String>,
    pub revoked_at: Option<String>,
}

/// Returned once from `create_token`; `token` is never stored or shown again.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewToken {
    pub token: String,
    pub info: TokenInfo,
}

/// The authenticated agent behind a bearer token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPrincipal {
    pub agent_id: String,
    pub token_id: String,
    pub name: String,
    pub color: String,
    pub scopes: Vec<String>,
}

impl AgentPrincipal {
    pub fn has_scope(&self, scope: &str) -> bool {
        self.scopes.iter().any(|s| s == scope)
    }
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).expect("OS random source unavailable");
    b
}

fn new_id() -> String {
    random_bytes::<16>()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn hash_token(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub(crate) fn normalize_scopes(scopes: Option<&[String]>) -> Result<Vec<String>, StorageError> {
    let Some(scopes) = scopes else {
        return Ok(SCOPES.iter().map(|s| s.to_string()).collect());
    };
    let mut out = Vec::new();
    for s in SCOPES {
        if scopes.iter().any(|x| x == s) {
            out.push(s.to_string());
        }
    }
    if let Some(bad) = scopes.iter().find(|s| !SCOPES.contains(&s.as_str())) {
        return Err(StorageError::Invalid(format!("unknown scope: {bad}")));
    }
    if out.is_empty() {
        return Err(StorageError::Invalid(
            "at least one scope is required".into(),
        ));
    }
    Ok(out)
}

fn valid_color(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|ch| ch.is_ascii_hexdigit())
}

fn row_agent(r: &rusqlite::Row) -> rusqlite::Result<Agent> {
    Ok(Agent {
        id: r.get(0)?,
        name: r.get(1)?,
        color: r.get(2)?,
        created_at: r.get(3)?,
        revoked_at: r.get(4)?,
        primary: r.get::<_, i64>(5)? != 0,
        last_seen_at: r.get(6)?,
    })
}

const AGENT_COLS: &str = "id, name, color, created_at, revoked_at, is_primary, last_seen_at";

/// Agents visible to the app: active rows plus revoked agents that still have open review items
/// (#192). Revoked agents with no pending comments or suggestions are omitted entirely.
const LIST_AGENTS_WHERE: &str = "WHERE revoked_at IS NULL
    OR EXISTS (
        SELECT 1 FROM comments c
        WHERE c.author_kind = 'agent' AND c.author_id = agents.id AND c.resolved_at IS NULL
    )
    OR EXISTS (
        SELECT 1 FROM suggestions s
        WHERE s.author_kind = 'agent' AND s.author_id = agents.id AND s.status = 'open'
    )";

fn row_token(r: &rusqlite::Row) -> rusqlite::Result<TokenInfo> {
    let scopes: String = r.get(3)?;
    Ok(TokenInfo {
        id: r.get(0)?,
        agent_id: r.get(1)?,
        prefix: r.get(2)?,
        scopes: scopes.split(' ').map(str::to_string).collect(),
        created_at: r.get(4)?,
        last_used_at: r.get(5)?,
        revoked_at: r.get(6)?,
    })
}

/// `app_meta` key for the writer display name from Settings → Your name & color (#45).
pub const USER_DISPLAY_NAME_META_KEY: &str = "user_display_name";

/// Names an agent may not take, so it can't pass for the local user or a UI fallback label
/// (RAD-263). The UI fallback "You" is always reserved; [`reserved_name`] also takes the saved
/// user display name once one exists in [`USER_DISPLAY_NAME_META_KEY`].
pub const RESERVED_AGENT_NAMES: &[&str] = &["You", "Unnamed agent", "Removed agent"];

/// Whether `name` is reserved: one of [`RESERVED_AGENT_NAMES`] or the local user's display name
/// (if set). Compared by [`name_key`].
fn reserved_name(name: &str, user_display_name: Option<&str>) -> bool {
    let key = name_key(name);
    RESERVED_AGENT_NAMES
        .iter()
        .copied()
        .chain(user_display_name.filter(|n| !n.trim().is_empty()))
        .any(|r| name_key(r) == key)
}

/// Writer display names that must stay distinct from agents and UI labels (#184).
fn reserved_user_display_name(name: &str) -> bool {
    reserved_name(name, None) || name_key(name) == name_key(DEFAULT_AGENT_NAME)
}

/// Zero-width characters and bidi controls, invisible in labels; stripped before comparing.
fn invisible(c: char) -> bool {
    matches!(
        c,
        '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'
    )
}

/// Agent name as stored: invisible characters removed, trimmed, NFC.
fn clean_name(name: &str) -> String {
    let visible: String = name.chars().filter(|&c| !invisible(c)).collect();
    visible.trim().nfc().collect()
}

/// Comparison key for agent names: invisible characters removed, trimmed, NFKC (so fullwidth
/// and compatibility forms match), then case-folded (lowercase plus the full folds that
/// `to_lowercase` leaves out: ß/ẞ -> ss, final sigma -> sigma).
fn name_key(name: &str) -> String {
    let visible: String = name.chars().filter(|&c| !invisible(c)).collect();
    let folded: String = visible
        .trim()
        .nfkc()
        .collect::<String>()
        .to_lowercase()
        .chars()
        .flat_map(|c| match c {
            '\u{DF}' => vec!['s', 's'],
            '\u{3C2}' => vec!['\u{3C3}'],
            c => vec![c],
        })
        .collect();
    // Folding can produce new compatibility/composition forms; normalize once more.
    folded.nfkc().collect()
}

const TOKEN_COLS: &str = "id, agent_id, prefix, scopes, created_at, last_used_at, revoked_at";

/// Insert an agent row on an open connection (used by pairing approve in one transaction).
pub(crate) fn insert_agent(
    c: &rusqlite::Connection,
    name: &str,
    color: &str,
) -> Result<Agent, StorageError> {
    let name = clean_name(name);
    let name = name.as_str();
    if name.is_empty() || name.chars().count() > 64 {
        return Err(StorageError::Invalid("name must be 1-64 characters".into()));
    }
    let key = name_key(name);
    if !valid_color(color) {
        return Err(StorageError::Invalid("color must look like #rrggbb".into()));
    }
    let id = new_id();
    let user_display_name: Option<String> = c
        .query_row(
            "SELECT value FROM app_meta WHERE key = ?1",
            [USER_DISPLAY_NAME_META_KEY],
            |r| r.get(0),
        )
        .optional()?;
    if reserved_name(name, user_display_name.as_deref()) {
        return Err(StorageError::Invalid(format!(
            "\"{name}\" is reserved; choose another agent name"
        )));
    }
    let taken = {
        let mut st = c.prepare("SELECT name FROM agents WHERE revoked_at IS NULL")?;
        let names = st
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        names.iter().any(|n| name_key(n) == key)
    };
    if taken {
        return Err(StorageError::Invalid(format!(
            "an agent named \"{name}\" already exists; choose another name"
        )));
    }
    let has_primary = c
        .query_row(
            "SELECT 1 FROM agents WHERE is_primary = 1 AND revoked_at IS NULL LIMIT 1",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    let make_primary = !has_primary && name_key(name) == name_key(DEFAULT_AGENT_NAME);
    c.execute(
        &format!(
            "INSERT INTO agents (id, name, color, created_at, is_primary)
             VALUES (?1, ?2, ?3, {NOW}, ?4)"
        ),
        params![id, name, color, i64::from(make_primary)],
    )?;
    Ok(c.query_row(
        &format!("SELECT {AGENT_COLS} FROM agents WHERE id = ?1"),
        [&id],
        row_agent,
    )?)
}

/// Mint a token on an open connection (plaintext returned once; hash stored).
pub(crate) fn insert_token(
    c: &rusqlite::Connection,
    agent_id: &str,
    scopes: Option<&[String]>,
) -> Result<NewToken, StorageError> {
    let scopes = normalize_scopes(scopes)?;
    let token = format!(
        "{TOKEN_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(random_bytes::<32>())
    );
    let prefix: String = token.chars().take(TOKEN_PREFIX.len() + 6).collect();
    let id = new_id();
    let active: Option<i64> = c
        .query_row(
            "SELECT 1 FROM agents WHERE id = ?1 AND revoked_at IS NULL",
            [agent_id],
            |r| r.get(0),
        )
        .optional()?;
    if active.is_none() {
        return Err(StorageError::NotFound(format!("active agent {agent_id}")));
    }
    c.execute(
        &format!(
            "INSERT INTO agent_tokens (id, agent_id, token_hash, prefix, scopes, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, {NOW})"
        ),
        params![id, agent_id, hash_token(&token), prefix, scopes.join(" ")],
    )?;
    let info = c.query_row(
        &format!("SELECT {TOKEN_COLS} FROM agent_tokens WHERE id = ?1"),
        [&id],
        row_token,
    )?;
    Ok(NewToken { token, info })
}

impl Store {
    pub fn create_agent(&self, name: &str, color: &str) -> Result<Agent, StorageError> {
        self.with_conn(|c| insert_agent(c, name, color))
    }

    /// Persist the writer display name from Settings (#45). Rejects names that collide with an
    /// active agent or a reserved label; normalization matches agent naming ([`name_key`]).
    pub fn set_user_display_name(&self, name: &str) -> Result<String, StorageError> {
        let name = clean_name(name);
        let name = name.as_str();
        if name.is_empty() || name.chars().count() > 64 {
            return Err(StorageError::Invalid("name must be 1-64 characters".into()));
        }
        if reserved_user_display_name(name) {
            return Err(StorageError::Invalid(format!(
                "\"{name}\" is reserved; choose another name"
            )));
        }
        let key = name_key(name);
        self.with_conn(|c| {
            let taken = {
                let mut st = c.prepare("SELECT name FROM agents WHERE revoked_at IS NULL")?;
                let names = st
                    .query_map([], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                names.iter().any(|n| name_key(n) == key)
            };
            if taken {
                return Err(StorageError::Invalid(format!(
                    "\"{name}\" is already used by an agent; choose another name"
                )));
            }
            c.execute(
                "INSERT OR REPLACE INTO app_meta (key, value) VALUES (?1, ?2)",
                params![USER_DISPLAY_NAME_META_KEY, name],
            )?;
            Ok(name.to_string())
        })
    }

    pub fn list_agents(&self) -> Result<Vec<Agent>, StorageError> {
        self.with_conn(|c| {
            let mut st = c.prepare(&format!(
                "SELECT {AGENT_COLS} FROM agents {LIST_AGENTS_WHERE} ORDER BY created_at, id"
            ))?;
            let rows = st.query_map([], row_agent)?.collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    /// Active primary agent id, if any. Revoked primaries are ignored.
    pub fn primary_agent_id(&self) -> Result<Option<String>, StorageError> {
        self.with_conn(|c| {
            c.query_row(
                "SELECT id FROM agents WHERE is_primary = 1 AND revoked_at IS NULL LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(StorageError::from)
        })
    }

    /// Revoke an agent and all of its tokens.
    pub fn revoke_agent(&self, agent_id: &str) -> Result<(), StorageError> {
        // One transaction for both updates; the token cache is evicted after commit while the
        // connection lock is still held, so no authentication can interleave.
        self.with_conn(|c| {
            let tx = c.unchecked_transaction()?;
            let hashes = token_hashes(&tx, "agent_id", agent_id)?;
            let n = tx.execute(
                &format!("UPDATE agents SET revoked_at = {NOW} WHERE id = ?1 AND revoked_at IS NULL"),
                [agent_id],
            )?;
            tx.execute(
                &format!("UPDATE agent_tokens SET revoked_at = {NOW} WHERE agent_id = ?1 AND revoked_at IS NULL"),
                [agent_id],
            )?;
            if n == 0 && !exists(&tx, "agents", agent_id)? {
                return Err(StorageError::NotFound(format!("agent {agent_id}")));
            }
            tx.commit()?;
            self.forget_token_hashes(&hashes);
            Ok(())
        })
    }

    pub fn create_token(
        &self,
        agent_id: &str,
        scopes: Option<&[String]>,
    ) -> Result<NewToken, StorageError> {
        self.with_conn(|c| insert_token(c, agent_id, scopes))
    }

    pub fn list_tokens(&self, agent_id: &str) -> Result<Vec<TokenInfo>, StorageError> {
        self.with_conn(|c| {
            let mut st = c.prepare(&format!(
                "SELECT {TOKEN_COLS} FROM agent_tokens WHERE agent_id = ?1 ORDER BY created_at, id"
            ))?;
            let rows = st
                .query_map([agent_id], row_token)?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    pub fn revoke_token(&self, token_id: &str) -> Result<(), StorageError> {
        self.with_conn(|c| {
            let tx = c.unchecked_transaction()?;
            let hashes = token_hashes(&tx, "id", token_id)?;
            let n = tx.execute(
                &format!("UPDATE agent_tokens SET revoked_at = {NOW} WHERE id = ?1 AND revoked_at IS NULL"),
                [token_id],
            )?;
            if n == 0 && !exists(&tx, "agent_tokens", token_id)? {
                return Err(StorageError::NotFound(format!("token {token_id}")));
            }
            tx.commit()?;
            self.forget_token_hashes(&hashes);
            Ok(())
        })
    }

    /// Resolve a presented bearer token to its agent. Returns `None` for unknown, revoked, or
    /// malformed tokens, or tokens whose agent is revoked. Updates `last_used_at` when it is more
    /// than a minute old, ignoring write errors.
    pub fn authenticate(&self, token: &str) -> Result<Option<AgentPrincipal>, StorageError> {
        if !token.starts_with(TOKEN_PREFIX) || token.len() > 128 {
            return Ok(None);
        }
        let hash = hash_token(token);
        self.with_conn(|c| {
            let p = c
                .query_row(
                    "SELECT t.id, a.id, a.name, a.color, t.scopes
                     FROM agent_tokens t JOIN agents a ON a.id = t.agent_id
                     WHERE t.token_hash = ?1 AND t.revoked_at IS NULL AND a.revoked_at IS NULL",
                    [&hash],
                    |r| {
                        let scopes: String = r.get(4)?;
                        Ok(AgentPrincipal {
                            token_id: r.get(0)?,
                            agent_id: r.get(1)?,
                            name: r.get(2)?,
                            color: r.get(3)?,
                            scopes: scopes.split(' ').map(str::to_string).collect(),
                        })
                    },
                )
                .optional()?;
            if let Some(p) = &p {
                // Cache under the connection lock so a concurrent revoke (which evicts under the
                // same lock after commit) can't be undone by a late insert.
                self.remember_token_hash(hash.clone());
                // Best effort and at most once a minute: a failed write must not fail auth.
                let _ = c.execute(
                    &format!(
                        "UPDATE agent_tokens SET last_used_at = {NOW} WHERE id = ?1
                         AND (last_used_at IS NULL
                              OR last_used_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-60 seconds'))"
                    ),
                    [&p.token_id],
                );
                let _ = c.execute(
                    &format!(
                        "UPDATE agents SET last_seen_at = {NOW} WHERE id = ?1
                         AND (last_seen_at IS NULL
                              OR last_seen_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 seconds'))"
                    ),
                    [&p.agent_id],
                );
            }
            if p.is_none() {
                // A cached hash whose row is now revoked or gone (restore, out-of-band edit).
                self.forget_token_hashes(std::slice::from_ref(&hash));
            }
            Ok(p)
        })
    }
}

fn exists(c: &rusqlite::Connection, table: &str, id: &str) -> Result<bool, StorageError> {
    Ok(c.query_row(
        &format!("SELECT 1 FROM {table} WHERE id = ?1"),
        [id],
        |_| Ok(()),
    )
    .optional()?
    .is_some())
}

/// Token hashes in `agent_tokens` where `col` (`id` or `agent_id`) equals `val`.
fn token_hashes(
    c: &rusqlite::Connection,
    col: &str,
    val: &str,
) -> Result<Vec<String>, StorageError> {
    let mut st = c.prepare(&format!(
        "SELECT token_hash FROM agent_tokens WHERE {col} = ?1"
    ))?;
    let rows = st
        .query_map([val], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invisible_characters_and_case_folds_cannot_dodge_the_checks() {
        let (_t, s) = store();
        for bad in [
            "You\u{200E}",
            "\u{200B}You",
            "Y\u{FEFF}ou",
            "\u{2066}you\u{2069}",
            "\u{FF39}\u{FF4F}\u{FF55}", // fullwidth "You"
            "Removed\u{2060} agent",
        ] {
            let e = s.create_agent(bad, "#3366ff").unwrap_err();
            assert!(
                matches!(e, StorageError::Invalid(ref m) if m.contains("reserved")),
                "{bad:?}"
            );
        }
        let a = s.create_agent("Stra\u{DF}e Bot", "#3366ff").unwrap();
        assert_eq!(a.name, "Stra\u{DF}e Bot");
        for dup in [
            "STRASSE BOT",
            "strasse bot",
            "Stra\u{1E9E}e Bot",
            "Stra\u{DF}e\u{200D} Bot",
        ] {
            let e = s.create_agent(dup, "#3366ff").unwrap_err();
            assert!(
                matches!(e, StorageError::Invalid(ref m) if m.contains("already exists")),
                "{dup:?}"
            );
        }
        // Stored names have invisible characters removed.
        let b = s.create_agent("\u{202E}Mirror\u{200F}", "#3366ff").unwrap();
        assert_eq!(b.name, "Mirror");
    }

    #[test]
    fn reserves_the_users_display_name_when_set() {
        // Synthetic name; trimmed, NFC and case-insensitive.
        assert!(reserved_name("  jo\u{308}rn ", Some("J\u{f6}rn")));
        assert!(reserved_name("you", Some("J\u{f6}rn")));
        assert!(!reserved_name("Helper", Some("J\u{f6}rn")));
        // No name set (or blank): only the fixed list.
        assert!(!reserved_name("J\u{f6}rn", None));
        assert!(!reserved_name("Helper", Some("  ")));
        assert!(reserved_name("You", None));
    }

    #[test]
    fn create_agent_rejects_the_saved_user_display_name() {
        let (_t, s) = store();
        s.set_user_display_name("J\u{f6}rn").unwrap();
        let e = s.create_agent("  jo\u{308}rn ", "#3366ff").unwrap_err();
        assert!(
            matches!(e, StorageError::Invalid(ref m) if m.contains("reserved")),
            "{e:?}"
        );
        s.create_agent("Helper", "#3366ff").unwrap();
    }

    #[test]
    fn set_user_display_name_rejects_default_agent_name_without_agent() {
        let (_t, s) = store();
        for bad in [DEFAULT_AGENT_NAME, "  GROK bot ", "Gro\u{200B}k Bot"] {
            let e = s.set_user_display_name(bad).unwrap_err();
            assert!(
                matches!(e, StorageError::Invalid(ref m) if m.contains("reserved")),
                "{bad:?}: {e:?}"
            );
        }
        assert!(s.create_agent(DEFAULT_AGENT_NAME, "#3366ff").is_ok());
    }

    #[test]
    fn set_user_display_name_rejects_reserved_ui_labels() {
        let (_t, s) = store();
        for bad in ["You", "  UNNAMED agent ", "Removed agent"] {
            let e = s.set_user_display_name(bad).unwrap_err();
            assert!(
                matches!(e, StorageError::Invalid(ref m) if m.contains("reserved")),
                "{bad}: {e:?}"
            );
        }
    }

    #[test]
    fn set_user_display_name_rejects_active_agent_names() {
        let (_t, s) = store();
        s.create_agent("Line Editor", "#3366ff").unwrap();
        let e = s.set_user_display_name("  line EDITOR ").unwrap_err();
        assert!(
            matches!(e, StorageError::Invalid(ref m) if m.contains("already used by an agent")),
            "{e:?}"
        );
        assert!(s.set_user_display_name("Writer").is_ok());
        let stored: String = s
            .with_conn(|c| {
                Ok(c.query_row(
                    "SELECT value FROM app_meta WHERE key = ?1",
                    [USER_DISPLAY_NAME_META_KEY],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(stored, "Writer");
    }

    #[test]
    fn set_user_display_name_allows_revoked_agent_names() {
        let (_t, s) = store();
        let a = s.create_agent("Line Editor", "#3366ff").unwrap();
        s.revoke_agent(&a.id).unwrap();
        assert!(s.set_user_display_name("Line Editor").is_ok());
    }

    #[test]
    fn live_agent_name_collision_is_clear() {
        let (_t, s) = store();
        s.create_agent("Line Editor", "#3366ff").unwrap();
        let e = s.create_agent("  LINE editor ", "#112233").unwrap_err();
        assert!(
            matches!(e, StorageError::Invalid(ref m) if m.contains("already exists")),
            "{e:?}"
        );
    }

    #[test]
    fn revoked_agent_name_can_be_reused() {
        let (_t, s) = store();
        let first = s.create_agent("Copy Bot", "#3366ff").unwrap();
        s.revoke_agent(&first.id).unwrap();
        let second = s.create_agent("copy bot", "#112233").unwrap();
        assert_ne!(second.id, first.id);
        assert_eq!(second.name, "copy bot");
        assert!(second.revoked_at.is_none());
    }

    #[test]
    fn agent_names_reject_reserved_and_duplicates() {
        let (_t, s) = store();
        for bad in ["you", "  YOU ", "unnamed AGENT", "Removed agent"] {
            let e = s.create_agent(bad, "#3366ff").unwrap_err();
            assert!(
                matches!(e, StorageError::Invalid(ref m) if m.contains("reserved")),
                "{bad}"
            );
        }
        // Personal names are not hard-coded.
        for ok in ["Author", "Me", "Sam"] {
            s.create_agent(ok, "#3366ff").unwrap();
        }
        s.create_agent("Caf\u{e9} Helper", "#3366ff").unwrap();
        // Same name decomposed (e + combining acute), different case and padding.
        let e = s
            .create_agent("  cafe\u{301} HELPER ", "#3366ff")
            .unwrap_err();
        assert!(matches!(e, StorageError::Invalid(ref m) if m.contains("already exists")));
        // Revoked agents no longer reserve the name.
        let r = s.create_agent("Line Editor", "#3366ff").unwrap();
        s.revoke_agent(&r.id).unwrap();
        assert_eq!(
            s.list_agents().unwrap().len(),
            4,
            "revoked agents without open review are omitted from list_agents"
        );
        let reused = s.create_agent("line editor", "#3366ff").unwrap();
        assert_eq!(reused.name, "line editor");
        assert_ne!(reused.id, r.id);
        assert_eq!(s.list_agents().unwrap().len(), 5);
        // Names are stored NFC.
        let d = s.create_agent("Nai\u{308}ve", "#3366ff").unwrap();
        assert_eq!(d.name, "Na\u{ef}ve");
    }

    fn store() -> (tempfile::TempDir, Store) {
        let tmp = tempfile::tempdir().unwrap();
        let s = Store::open(tmp.path()).unwrap();
        (tmp, s)
    }

    #[test]
    fn token_is_shown_once_and_stored_hashed() {
        let (_t, s) = store();
        let a = s.create_agent(DEFAULT_AGENT_NAME, "#3366ff").unwrap();
        let t = s.create_token(&a.id, None).unwrap();
        assert!(t.token.starts_with(TOKEN_PREFIX));
        assert_eq!(t.info.scopes, vec!["read", "comment", "suggest"]);
        assert!(t.token.starts_with(&t.info.prefix));
        let stored: String = s
            .with_conn(
                |c| Ok(c.query_row("SELECT token_hash FROM agent_tokens", [], |r| r.get(0))?),
            )
            .unwrap();
        assert_eq!(stored, hash_token(&t.token));
        assert_ne!(stored, t.token);
        // The plaintext token appears nowhere in the database file.
        drop(s);
        let bytes = std::fs::read(_t.path().join(crate::storage::DB_FILENAME)).unwrap();
        let wal = std::fs::read(
            _t.path()
                .join(format!("{}-wal", crate::storage::DB_FILENAME)),
        )
        .unwrap_or_default();
        let needle = t.token.as_bytes();
        for buf in [&bytes, &wal] {
            assert!(!buf.windows(needle.len()).any(|w| w == needle));
        }
    }

    #[test]
    fn failed_last_used_write_does_not_fail_auth() {
        let (_t, s) = store();
        let a = s.create_agent("Grok Bot", "#3366ff").unwrap();
        let t = s.create_token(&a.id, Some(&["read".into()])).unwrap();
        s.with_conn(|c| {
            c.execute_batch(
                "CREATE TRIGGER no_touch BEFORE UPDATE OF last_used_at ON agent_tokens
                 BEGIN SELECT RAISE(ABORT, 'read-only'); END;",
            )?;
            Ok(())
        })
        .unwrap();
        assert!(s.authenticate(&t.token).unwrap().is_some());
        assert!(s.list_tokens(&a.id).unwrap()[0].last_used_at.is_none());
    }

    #[test]
    fn last_used_is_written_at_most_once_a_minute() {
        let (_t, s) = store();
        let a = s.create_agent("Grok Bot", "#3366ff").unwrap();
        let t = s.create_token(&a.id, Some(&["read".into()])).unwrap();
        s.authenticate(&t.token).unwrap().unwrap();
        let first = s.list_tokens(&a.id).unwrap()[0].last_used_at.clone();
        std::thread::sleep(std::time::Duration::from_millis(5));
        s.authenticate(&t.token).unwrap().unwrap();
        assert_eq!(s.list_tokens(&a.id).unwrap()[0].last_used_at, first);
    }

    #[test]
    fn authenticate_and_revoke() {
        let (_t, s) = store();
        let a = s.create_agent("Grok Bot", "#3366ff").unwrap();
        let t = s.create_token(&a.id, Some(&["read".into()])).unwrap();
        let p = s.authenticate(&t.token).unwrap().unwrap();
        assert_eq!(p.agent_id, a.id);
        assert_eq!(p.name, "Grok Bot");
        assert!(p.has_scope("read") && !p.has_scope("suggest"));
        assert!(s.list_tokens(&a.id).unwrap()[0].last_used_at.is_some());

        assert!(s.authenticate("cat_nope").unwrap().is_none());
        assert!(s.authenticate("garbage").unwrap().is_none());

        s.revoke_token(&t.info.id).unwrap();
        assert!(
            s.authenticate(&t.token).unwrap().is_none(),
            "revoked token fails immediately"
        );
        assert!(s.list_tokens(&a.id).unwrap()[0].revoked_at.is_some());
    }

    #[test]
    fn revoking_agent_revokes_its_tokens() {
        let (_t, s) = store();
        let a = s.create_agent("Grok Bot", "#3366ff").unwrap();
        let t1 = s.create_token(&a.id, None).unwrap();
        let t2 = s.create_token(&a.id, None).unwrap();
        s.revoke_agent(&a.id).unwrap();
        assert!(s.authenticate(&t1.token).unwrap().is_none());
        assert!(s.authenticate(&t2.token).unwrap().is_none());
        assert!(s.create_token(&a.id, None).is_err());
        assert!(
            s.list_agents().unwrap().is_empty(),
            "revoked agents with no open review drop off the list"
        );
    }

    #[test]
    fn list_agents_keeps_revoked_agent_with_open_suggestion() {
        use crate::manuscripts::{Author, ImportSection, Suggestion};

        let tmp = tempfile::tempdir().unwrap();
        let s = Store::open(tmp.path()).unwrap();
        let agent = s.create_agent("Line Bot", "#3366ff").unwrap();
        let (m, secs) = s
            .import_manuscript(
                "Harbor",
                &[ImportSection {
                    id: Some("c1".into()),
                    parent_id: None,
                    kind: "chapter".into(),
                    title: "One".into(),
                    doc: serde_json::json!({"type":"doc","content":[{"type":"paragraph","attrs":{"style":"body"},
                        "content":[{"type":"text","text":"Text."}]}]}),
                }],
            )
            .unwrap();
        let sid = secs[0].id.clone();
        s.insert_suggestion(
            &m.id,
            &Suggestion {
                id: "s1".into(),
                section_id: sid,
                block_id: None,
                kind: "replace".into(),
                quote: Some("Text".into()),
                replacement: Some("Words".into()),
                rationale: None,
                author: Author {
                    kind: "agent".into(),
                    id: agent.id.clone(),
                    name: agent.name.clone(),
                },
                status: "open".into(),
                created_at: "2026-01-01T00:00:00.000Z".into(),
            },
        )
        .unwrap();
        s.revoke_agent(&agent.id).unwrap();
        let listed = s.list_agents().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, agent.id);
        assert!(listed[0].revoked_at.is_some());
    }

    #[test]
    fn rejects_bad_input() {
        let (_t, s) = store();
        assert!(s.create_agent("", "#3366ff").is_err());
        assert!(s.create_agent("x", "blue").is_err());
        let a = s.create_agent("x", "#abcdef").unwrap();
        assert!(s.create_token(&a.id, Some(&["decide".into()])).is_err());
        assert!(s.create_token(&a.id, Some(&[])).is_err());
        assert!(matches!(
            s.revoke_token("missing"),
            Err(StorageError::NotFound(_))
        ));
        assert!(matches!(
            s.revoke_agent("missing"),
            Err(StorageError::NotFound(_))
        ));
    }

    #[test]
    fn tokens_are_unique() {
        let (_t, s) = store();
        let a = s.create_agent("x", "#abcdef").unwrap();
        let a1 = s.create_token(&a.id, None).unwrap().token;
        let a2 = s.create_token(&a.id, None).unwrap().token;
        assert_ne!(a1, a2);
        assert_eq!(a1.len(), TOKEN_PREFIX.len() + 43);
    }

    #[test]
    fn default_agent_name_is_primary_and_at_most_one() {
        let (_t, s) = store();
        let helper = s.create_agent("Line Editor", "#3366ff").unwrap();
        assert!(!helper.primary);
        assert!(s.primary_agent_id().unwrap().is_none());

        let grok = s.create_agent(DEFAULT_AGENT_NAME, "#3366ff").unwrap();
        assert!(grok.primary);
        assert_eq!(
            s.primary_agent_id().unwrap().as_deref(),
            Some(grok.id.as_str())
        );
        assert_eq!(
            s.list_agents()
                .unwrap()
                .iter()
                .filter(|a| a.primary)
                .count(),
            1
        );

        let other = s.create_agent("Copy Bot", "#112233").unwrap();
        assert!(!other.primary);
        assert_eq!(
            s.primary_agent_id().unwrap().as_deref(),
            Some(grok.id.as_str())
        );
    }

    #[test]
    fn renamed_primary_stays_primary_when_new_default_name_agent_is_created() {
        let (_t, s) = store();
        let grok = s.create_agent(DEFAULT_AGENT_NAME, "#3366ff").unwrap();
        assert!(grok.primary);
        s.with_conn(|c| {
            c.execute(
                "UPDATE agents SET name = ?1 WHERE id = ?2",
                params!["Renamed Bot", grok.id],
            )?;
            Ok(())
        })
        .unwrap();
        let impostor = s.create_agent(DEFAULT_AGENT_NAME, "#112233").unwrap();
        assert!(!impostor.primary);
        assert_eq!(
            s.primary_agent_id().unwrap().as_deref(),
            Some(grok.id.as_str())
        );
        let grok_row = s
            .list_agents()
            .unwrap()
            .into_iter()
            .find(|a| a.id == grok.id)
            .unwrap();
        assert!(grok_row.primary);
        assert_eq!(grok_row.name, "Renamed Bot");
    }
}
