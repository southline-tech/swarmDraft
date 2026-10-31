//! MCP agent pairing (#188): pending requests approved in-app, token delivered once via poll.

use crate::agents::{hash_token, normalize_scopes, Agent, NewToken};
use crate::storage::{StorageError, Store};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

pub const PAIRING_SECRET_PREFIX: &str = "pair_";
const PAIRING_TTL_SECS: i64 = 300;
const MAX_PENDING: i64 = 3;
const PAIRING_RATE_WINDOW_SECS: i64 = 60;
const PAIRING_RATE_MAX: i64 = 5;

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
             WHERE status = 'pending' AND expires_at < {NOW}"
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

fn pairing_rate_ok(c: &rusqlite::Connection) -> Result<bool, StorageError> {
    let n: i64 = c.query_row(
        &format!(
            "SELECT count(*) FROM agent_pairings
             WHERE created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now',?1)"
        ),
        [format!("-{PAIRING_RATE_WINDOW_SECS} seconds")],
        |r| r.get(0),
    )?;
    Ok(n < PAIRING_RATE_MAX)
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
            if !pairing_rate_ok(c)? {
                return Err(StorageError::Invalid(
                    "too many pairing requests; try again later".into(),
                ));
            }
            if count_pending(c)? >= MAX_PENDING {
                return Err(StorageError::Invalid(
                    "too many pending pairing requests".into(),
                ));
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
                "pending" => {
                    let expired: bool = c
                        .query_row(
                            &format!(
                                "SELECT 1 WHERE ?1 < strftime('%Y-%m-%dT%H:%M:%fZ','now')"
                            ),
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
    ) -> Result<(Agent, NewToken), StorageError> {
        let pending = self.with_conn(|c| {
            expire_stale(c)?;
            c.query_row(
                "SELECT name, color, requested_scopes FROM agent_pairings
                 WHERE id = ?1 AND status = 'pending'",
                [pairing_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(StorageError::from)
        })?;
        let Some((name, color, requested)) = pending else {
            return Err(StorageError::NotFound(format!("pairing {pairing_id}")));
        };
        let req_scopes: Vec<String> = requested.split(' ').map(str::to_string).collect();
        let mut approved = normalize_scopes(scopes)?;
        approved.retain(|s| req_scopes.iter().any(|r| r == s));
        if approved.is_empty() {
            approved = req_scopes;
        }
        let agent = self.create_agent(&name, &color)?;
        let token = self.create_token(&agent.id, Some(&approved))?;
        self.with_conn(|c| {
            let n = c.execute(
                &format!(
                    "UPDATE agent_pairings SET status = 'approved', resolved_at = {NOW},
                     agent_id = ?2, approved_scopes = ?3, delivery_token = ?4
                     WHERE id = ?1 AND status = 'pending'"
                ),
                params![pairing_id, agent.id, approved.join(" "), token.token],
            )?;
            if n == 0 {
                return Err(StorageError::Invalid("pairing is no longer pending".into()));
            }
            Ok(())
        })?;
        Ok((agent, token))
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
    fn approve_gives_token_exactly_once() {
        let (_t, s) = store();
        let r = s
            .request_pairing(DEFAULT_AGENT_NAME, Some("#112233"), None)
            .unwrap();
        s.approve_pairing(&r.pairing_id, None).unwrap();
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
        assert!(s.approve_pairing(&r.pairing_id, None).is_err());
    }

    #[test]
    fn rate_limits_pairing_requests_per_minute() {
        let (_t, s) = store();
        for i in 0..5 {
            let r = s.request_pairing(&format!("Bot {i}"), None, None).unwrap();
            s.deny_pairing(&r.pairing_id).unwrap();
        }
        assert!(s.request_pairing("One too many", None, None).is_err());
    }
}
