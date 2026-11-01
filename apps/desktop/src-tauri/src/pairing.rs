//! MCP agent pairing (#188): pending requests approved in-app, token delivered once via poll.

use crate::agents::{hash_token, insert_agent, insert_token, normalize_scopes, Agent, NewToken};
use crate::storage::{StorageError, Store};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

pub const PAIRING_SECRET_PREFIX: &str = "pair_";
const PAIRING_TTL_SECS: i64 = 300;
pub(crate) const MAX_PENDING: i64 = 20;
const PAIRING_RATE_WINDOW_SECS: i64 = 60;
pub(crate) const PAIRING_RATE_MAX: i64 = 20;

const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingSummary {
    pub id: String,
    pub name: String,
    pub color: String,
    pub requested_scopes: Vec<String>,
    pub created_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestPairingResult {
    pub pairing_id: String,
    pub pairing_secret: String,
    pub status: &'static str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PollPairingResult {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

impl PollPairingResult {
    pub fn pending() -> Self {
        Self {
            status: "pending".into(),
            token: None,
        }
    }
    pub fn denied() -> Self {
        Self {
            status: "denied".into(),
            token: None,
        }
    }
    pub fn expired() -> Self {
        Self {
            status: "expired".into(),
            token: None,
        }
    }
    pub fn approved(token: String) -> Self {
        Self {
            status: "approved".into(),
            token: Some(token),
        }
    }
}

fn hash_secret(secret: &str) -> String {
    hash_token(secret)
}

fn new_pairing_id() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("OS random source unavailable");
    b.iter().map(|b| format!("{b:02x}")).collect()
}

fn random_pairing_secret() -> String {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).expect("OS random source unavailable");
    format!("{PAIRING_SECRET_PREFIX}{}", URL_SAFE_NO_PAD.encode(b))
}

fn expire_stale(c: &rusqlite::Connection) -> Result<(), StorageError> {
    c.execute(
        &format!(
            "UPDATE agent_pairings SET status = 'expired', resolved_at = {NOW}
             WHERE status IN ('pending', 'approving') AND expires_at < {NOW}"
        ),
        [],
    )?;
    Ok(())
}

fn count_pending(c: &rusqlite::Connection) -> Result<i64, StorageError> {
    expire_stale(c)?;
    let n: i64 = c.query_row(
        "SELECT count(*) FROM agent_pairings WHERE status = 'pending'",
        [],
        |r| r.get(0),
    )?;
    Ok(n)
}

fn pairing_rate_count(c: &rusqlite::Connection) -> Result<i64, StorageError> {
    c.query_row(
        "SELECT count(*) FROM agent_pairings
             WHERE created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now',?1)",
        [format!("-{PAIRING_RATE_WINDOW_SECS} seconds")],
        |r| r.get(0),
    )
    .map_err(StorageError::from)
}

/// Seconds until the oldest request in the rate window falls out (at least 1).
fn pairing_rate_retry_after_secs(c: &rusqlite::Connection) -> Result<i64, StorageError> {
    let secs: i64 = c
        .query_row(
            "SELECT MAX(1, CAST(
                (julianday(strftime('%Y-%m-%dT%H:%M:%fZ','now',?2))
                 - julianday(created_at)) * 86400 AS INTEGER))
             FROM agent_pairings
             WHERE created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now',?1)",
            [
                format!("-{PAIRING_RATE_WINDOW_SECS} seconds"),
                format!("+{PAIRING_RATE_WINDOW_SECS} seconds"),
            ],
            |r| r.get(0),
        )
        .unwrap_or(PAIRING_RATE_WINDOW_SECS);
    Ok(secs.clamp(1, PAIRING_RATE_WINDOW_SECS))
}

/// Seconds until the soonest pending pairing expires (at least 1).
fn pending_limit_retry_after_secs(c: &rusqlite::Connection) -> Result<i64, StorageError> {
    let secs: i64 = c
        .query_row(
            "SELECT MAX(1, CAST(
                (julianday(MIN(expires_at)) - julianday(strftime('%Y-%m-%dT%H:%M:%fZ','now')))
                * 86400 AS INTEGER))
             FROM agent_pairings WHERE status = 'pending'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(1);
    Ok(secs.max(1))
}

fn pairing_limit_message(kind: &str, retry_after_secs: i64) -> String {
    format!("{kind}; retry after {retry_after_secs} seconds")
}

impl Store {
    pub fn request_pairing(
        &self,
        name: &str,
        color: Option<&str>,
        scopes: Option<&[String]>,
    ) -> Result<RequestPairingResult, StorageError> {
        let scopes = normalize_scopes(scopes)?;
        let color = color.unwrap_or("#3366ff");
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 64 {
            return Err(StorageError::Invalid("name must be 1-64 characters".into()));
        }
        if color.len() != 7 || !color.starts_with('#') {
            return Err(StorageError::Invalid("color must look like #rrggbb".into()));
        }
        let secret = random_pairing_secret();
        let secret_hash = hash_secret(&secret);
        let id = new_pairing_id();
        let scopes_s = scopes.join(" ");
        self.with_conn(|c| {
            if pairing_rate_count(c)? >= PAIRING_RATE_MAX {
                let retry = pairing_rate_retry_after_secs(c)?;
                return Err(StorageError::Invalid(pairing_limit_message(
                    "too many pairing requests in the last minute",
                    retry,
                )));
            }
            if count_pending(c)? >= MAX_PENDING {
                let retry = pending_limit_retry_after_secs(c)?;
                return Err(StorageError::Invalid(pairing_limit_message(
                    "too many pending pairing requests",
                    retry,
                )));
            }
            c.execute(
                &format!(
                    "INSERT INTO agent_pairings
                     (id, name, color, requested_scopes, secret_hash, status, created_at, expires_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, 'pending', {NOW},
                             strftime('%Y-%m-%dT%H:%M:%fZ','now',?6))"
                ),
                params![id, name, color, scopes_s, secret_hash, format!("+{PAIRING_TTL_SECS} seconds")],
            )?;
            Ok(RequestPairingResult {
                pairing_id: id,
                pairing_secret: secret,
                status: "pending",
            })
        })
    }

    pub fn poll_pairing(
        &self,
        pairing_id: &str,
        pairing_secret: &str,
    ) -> Result<PollPairingResult, StorageError> {
        if pairing_id.len() > 128 || pairing_secret.len() > 128 {
            return Ok(PollPairingResult::denied());
        }
        let hash = hash_secret(pairing_secret);
        self.with_conn(|c| {
            expire_stale(c)?;
            let row = c
                .query_row(
                    "SELECT status, secret_hash, delivery_token, expires_at
                     FROM agent_pairings WHERE id = ?1",
                    [pairing_id],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, Option<String>>(2)?,
                            r.get::<_, String>(3)?,
                        ))
                    },
                )
                .optional()?;
            let Some((status, stored_hash, delivery, expires_at)) = row else {
                return Ok(PollPairingResult::denied());
            };
            if hash != stored_hash {
                return Ok(PollPairingResult::denied());
            }
            match status.as_str() {
                "pending" | "approving" => {
                    let expired: bool = c
                        .query_row(
                            "SELECT 1 WHERE ?1 < strftime('%Y-%m-%dT%H:%M:%fZ','now')",
                            [&expires_at],
                            |_| Ok(()),
                        )
                        .optional()?
                        .is_some();
                    if expired {
                        c.execute(
                            &format!(
                                "UPDATE agent_pairings SET status = 'expired', resolved_at = {NOW} WHERE id = ?1"
                            ),
                            [pairing_id],
                        )?;
                        return Ok(PollPairingResult::expired());
                    }
                    Ok(PollPairingResult::pending())
                }
                "denied" => Ok(PollPairingResult::denied()),
                "expired" => Ok(PollPairingResult::expired()),
                "approved" => {
                    let Some(token) = delivery else {
                        return Ok(PollPairingResult::denied());
                    };
                    c.execute(
                        "UPDATE agent_pairings SET delivery_token = NULL WHERE id = ?1",
                        [pairing_id],
                    )?;
                    Ok(PollPairingResult::approved(token))
                }
                _ => Ok(PollPairingResult::denied()),
            }
        })
    }

    pub fn list_pending_pairings(&self) -> Result<Vec<PairingSummary>, StorageError> {
        self.with_conn(|c| {
            expire_stale(c)?;
            let mut st = c.prepare(
                "SELECT id, name, color, requested_scopes, created_at, expires_at
                 FROM agent_pairings WHERE status = 'pending' ORDER BY created_at, id",
            )?;
            let rows = st
                .query_map([], |r| {
                    let scopes: String = r.get(3)?;
                    Ok(PairingSummary {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        color: r.get(2)?,
                        requested_scopes: scopes.split(' ').map(str::to_string).collect(),
                        created_at: r.get(4)?,
                        expires_at: r.get(5)?,
                    })
                })?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    pub fn deny_pairing(&self, pairing_id: &str) -> Result<(), StorageError> {
        self.with_conn(|c| {
            let n = c.execute(
                &format!(
                    "UPDATE agent_pairings SET status = 'denied', resolved_at = {NOW}
                     WHERE id = ?1 AND status = 'pending'"
                ),
                [pairing_id],
            )?;
            if n == 0 {
                return Err(StorageError::NotFound(format!("pairing {pairing_id}")));
            }
            Ok(())
        })
    }

    pub fn approve_pairing(
        &self,
        pairing_id: &str,
        scopes: Option<&[String]>,
        grant_manuscript_id: Option<&str>,
    ) -> Result<(Agent, NewToken), StorageError> {
        let mut approved = normalize_scopes(scopes)?;
        self.with_conn_mut_storage(|c| {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            expire_stale(&tx)?;
            let claimed = tx.execute(
                "UPDATE agent_pairings SET status = 'approving' WHERE id = ?1 AND status = 'pending'",
                [pairing_id],
            )?;
            if claimed == 0 {
                return Err(StorageError::NotFound(format!("pairing {pairing_id}")));
            }
            let (name, color, requested) = tx.query_row(
                "SELECT name, color, requested_scopes FROM agent_pairings
                 WHERE id = ?1 AND status = 'approving'",
                [pairing_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                },
            )?;
            let req_scopes: Vec<String> = requested.split(' ').map(str::to_string).collect();
            if approved.is_empty() {
                approved = req_scopes.clone();
            } else {
                approved.retain(|s| req_scopes.iter().any(|r| r == s));
                if approved.is_empty() {
                    approved = req_scopes;
                }
            }
            let agent = insert_agent(&tx, &name, &color)?;
            if let Some(mid) = grant_manuscript_id {
                Store::grant_agent_manuscript_on_conn(&tx, &agent.id, mid)?;
            }
            let token = insert_token(&tx, &agent.id, Some(&approved))?;
            let n = tx.execute(
                &format!(
                    "UPDATE agent_pairings SET status = 'approved', resolved_at = {NOW},
                     agent_id = ?2, approved_scopes = ?3, delivery_token = ?4
                     WHERE id = ?1 AND status = 'approving'"
                ),
                params![pairing_id, agent.id, approved.join(" "), token.token],
            )?;
            if n == 0 {
                return Err(StorageError::Invalid(
                    "pairing is no longer pending".into(),
                ));
            }
            tx.commit()?;
            Ok((agent, token))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::DEFAULT_AGENT_NAME;

    fn store() -> (tempfile::TempDir, Store) {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().to_path_buf();
        (tmp, Store::open(&path).unwrap())
    }

    #[test]
    fn deny_and_expired_give_no_token() {
        let (_t, s) = store();
        let r = s
            .request_pairing("Helper Bot", Some("#3366ff"), None)
            .unwrap();
        s.deny_pairing(&r.pairing_id).unwrap();
        assert_eq!(
            s.poll_pairing(&r.pairing_id, &r.pairing_secret)
                .unwrap()
                .status,
            "denied"
        );
        let r2 = s.request_pairing("Other", None, None).unwrap();
        s.with_conn(|c| {
            c.execute(
                "UPDATE agent_pairings SET expires_at = '2000-01-01T00:00:00Z' WHERE id = ?1",
                [&r2.pairing_id],
            )?;
            Ok(())
        })
        .unwrap();
        assert!(matches!(
            s.poll_pairing(&r2.pairing_id, &r2.pairing_secret).unwrap().status,
            s if s == "expired"
        ));
    }

    #[test]
    fn wrong_secret_cannot_poll() {
        let (_t, s) = store();
        let r = s.request_pairing("Bot", None, None).unwrap();
        assert!(matches!(
            s.poll_pairing(&r.pairing_id, "pair_wrong").unwrap().status,
            s if s == "denied"
        ));
    }

    #[test]
    fn approve_grants_active_manuscript_when_requested() {
        let (_t, s) = store();
        let m = s.create_manuscript("Active draft").unwrap();
        let r = s.request_pairing("Scoped Bot", None, None).unwrap();
        let (agent, _) = s.approve_pairing(&r.pairing_id, None, Some(&m.id)).unwrap();
        assert!(s.agent_can_access_manuscript(&agent.id, &m.id).unwrap());
        let other = s.create_manuscript("Other").unwrap();
        assert!(!s.agent_can_access_manuscript(&agent.id, &other.id).unwrap());
    }

    #[test]
    fn approve_gives_token_exactly_once() {
        let (_t, s) = store();
        let r = s
            .request_pairing(DEFAULT_AGENT_NAME, Some("#112233"), None)
            .unwrap();
        s.approve_pairing(&r.pairing_id, None, None).unwrap();
        let p1 = s.poll_pairing(&r.pairing_id, &r.pairing_secret).unwrap();
        assert_eq!(p1.status, "approved");
        let token = p1.token.expect("token");
        assert!(token.starts_with("cat_"));
        assert!(matches!(
            s.poll_pairing(&r.pairing_id, &r.pairing_secret).unwrap().status,
            s if s == "denied"
        ));
    }

    #[test]
    fn reserved_name_rejected_at_approve() {
        let (_t, s) = store();
        let r = s.request_pairing("You", None, None).unwrap();
        assert!(s.approve_pairing(&r.pairing_id, None, None).is_err());
    }

    #[test]
    fn rate_limits_pairing_requests_per_minute() {
        let (_t, s) = store();
        for i in 0..PAIRING_RATE_MAX {
            let r = s.request_pairing(&format!("Bot {i}"), None, None).unwrap();
            s.deny_pairing(&r.pairing_id).unwrap();
        }
        let err = s.request_pairing("One too many", None, None).unwrap_err();
        assert!(
            matches!(err, StorageError::Invalid(ref m)
                if m.contains("too many pairing requests") && m.contains("retry after")),
            "{err:?}"
        );
    }

    #[test]
    fn at_most_max_pending_pairings() {
        let (_t, s) = store();
        for i in 0..MAX_PENDING {
            let _ = s
                .request_pairing(&format!("Pending {i}"), None, None)
                .unwrap();
        }
        // Pending rows stay, but stop counting against the per-minute rate cap.
        s.with_conn(|c| {
            c.execute(
                "UPDATE agent_pairings SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-120 seconds')
                 WHERE status = 'pending'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        let err = s.request_pairing("Overflow", None, None).unwrap_err();
        assert!(
            matches!(err, StorageError::Invalid(ref m)
                if m.contains("pending") && m.contains("retry after")),
            "{err:?}"
        );
    }

    #[test]
    fn five_pairings_including_revoked_name_all_approve() {
        let (_t, s) = store();
        let retired = s.create_agent("Line Editor", "#3366ff").unwrap();
        s.revoke_agent(&retired.id).unwrap();
        let names = [
            "Line Editor",
            "Copy Bot",
            "Continuity Bot",
            "Style Bot",
            "Fact Bot",
        ];
        let mut pending = Vec::new();
        for name in names {
            pending.push(s.request_pairing(name, None, None).unwrap());
        }
        assert_eq!(pending.len(), 5);
        for r in &pending {
            let (agent, token) = s.approve_pairing(&r.pairing_id, None, None).unwrap();
            assert!(token.token.starts_with("cat_"));
            assert!(agent.revoked_at.is_none());
        }
        let agents = s.list_agents().unwrap();
        assert_eq!(agents.len(), 5);
        let editors: Vec<_> = agents
            .iter()
            .filter(|a| a.name.eq_ignore_ascii_case("line editor"))
            .collect();
        assert_eq!(editors.len(), 1);
        assert_ne!(editors[0].id, retired.id);
    }

    #[test]
    fn user_display_name_collision_rejected_at_approve() {
        let (_t, s) = store();
        s.set_user_display_name("Writer").unwrap();
        let r = s.request_pairing("Writer", None, None).unwrap();
        assert!(s.approve_pairing(&r.pairing_id, None, None).is_err());
        assert_eq!(s.list_agents().unwrap().len(), 0);
        assert_eq!(
            s.poll_pairing(&r.pairing_id, &r.pairing_secret)
                .unwrap()
                .status,
            "pending"
        );
    }

    #[test]
    fn concurrent_approve_creates_one_agent() {
        let (_t, s) = store();
        let r = s.request_pairing("Race Bot", None, None).unwrap();
        let id1 = r.pairing_id.clone();
        let id2 = r.pairing_id;
        let s1 = s.clone();
        let s2 = s.clone();
        let h1 = std::thread::spawn(move || s1.approve_pairing(&id1, None, None));
        let h2 = std::thread::spawn(move || s2.approve_pairing(&id2, None, None));
        let r1 = h1.join().unwrap();
        let r2 = h2.join().unwrap();
        assert_ne!(r1.is_ok(), r2.is_ok());
        assert_eq!(s.list_agents().unwrap().len(), 1);
    }
}
