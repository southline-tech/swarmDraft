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

fn normalize_scopes(scopes: Option<&[String]>) -> Result<Vec<String>, StorageError> {
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
    })
}

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

const TOKEN_COLS: &str = "id, agent_id, prefix, scopes, created_at, last_used_at, revoked_at";

impl Store {
    pub fn create_agent(&self, name: &str, color: &str) -> Result<Agent, StorageError> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 64 {
            return Err(StorageError::Invalid("name must be 1-64 characters".into()));
        }
        if !valid_color(color) {
            return Err(StorageError::Invalid("color must look like #rrggbb".into()));
        }
        let id = new_id();
        self.with_conn(|c| {
            c.execute(
                &format!(
                    "INSERT INTO agents (id, name, color, created_at) VALUES (?1, ?2, ?3, {NOW})"
                ),
                params![id, name, color],
            )?;
            Ok(c.query_row(
                "SELECT id, name, color, created_at, revoked_at FROM agents WHERE id = ?1",
                [&id],
                row_agent,
            )?)
        })
    }

    pub fn list_agents(&self) -> Result<Vec<Agent>, StorageError> {
        self.with_conn(|c| {
            let mut st = c.prepare(
                "SELECT id, name, color, created_at, revoked_at FROM agents ORDER BY created_at, id",
            )?;
            let rows = st.query_map([], row_agent)?.collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    /// Revoke an agent and all of its tokens.
    pub fn revoke_agent(&self, agent_id: &str) -> Result<(), StorageError> {
        self.with_conn(|c| {
            let n = c.execute(
                &format!("UPDATE agents SET revoked_at = {NOW} WHERE id = ?1 AND revoked_at IS NULL"),
                [agent_id],
            )?;
            c.execute(
                &format!("UPDATE agent_tokens SET revoked_at = {NOW} WHERE agent_id = ?1 AND revoked_at IS NULL"),
                [agent_id],
            )?;
            if n == 0 && !exists(c, "agents", agent_id)? {
                return Err(StorageError::NotFound(format!("agent {agent_id}")));
            }
            Ok(())
        })
    }

    pub fn create_token(
        &self,
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
        self.with_conn(|c| {
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
        })
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
            let n = c.execute(
                &format!("UPDATE agent_tokens SET revoked_at = {NOW} WHERE id = ?1 AND revoked_at IS NULL"),
                [token_id],
            )?;
            if n == 0 && !exists(c, "agent_tokens", token_id)? {
                return Err(StorageError::NotFound(format!("token {token_id}")));
            }
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
                // Best effort and at most once a minute: a failed write must not fail auth.
                let _ = c.execute(
                    &format!(
                        "UPDATE agent_tokens SET last_used_at = {NOW} WHERE id = ?1
                         AND (last_used_at IS NULL
                              OR last_used_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-60 seconds'))"
                    ),
                    [&p.token_id],
                );
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

#[cfg(test)]
mod tests {
    use super::*;

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
        let bytes = std::fs::read(_t.path().join("coauthor.db")).unwrap();
        let wal = std::fs::read(_t.path().join("coauthor.db-wal")).unwrap_or_default();
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
        assert!(s.list_agents().unwrap()[0].revoked_at.is_some());
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
}
