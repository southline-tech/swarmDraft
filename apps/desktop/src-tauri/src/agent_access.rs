//! Per-agent manuscript (draft) access (#244): selected drafts or all drafts including future.

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::storage::{StorageError, Store};

pub const ACCESS_MODE_SELECTED: &str = "selected";
pub const ACCESS_MODE_ALL: &str = "all";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDraftAccess {
    pub agent_id: String,
    pub mode: String,
    pub manuscript_ids: Vec<String>,
}

const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

fn normalize_mode(mode: &str) -> Result<String, StorageError> {
    match mode {
        ACCESS_MODE_SELECTED => Ok(ACCESS_MODE_SELECTED.to_string()),
        ACCESS_MODE_ALL => Ok(ACCESS_MODE_ALL.to_string()),
        _ => Err(StorageError::Invalid(format!(
            "access mode must be '{ACCESS_MODE_SELECTED}' or '{ACCESS_MODE_ALL}'"
        ))),
    }
}

impl Store {
    pub fn agent_manuscript_access_mode(&self, agent_id: &str) -> Result<String, StorageError> {
        self.with_conn(|c| {
            c.query_row(
                "SELECT manuscript_access_mode FROM agents WHERE id = ?1 AND revoked_at IS NULL",
                [agent_id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound(format!("active agent {agent_id}")))
        })
    }

    pub fn set_agent_manuscript_access_mode(
        &self,
        agent_id: &str,
        mode: &str,
    ) -> Result<(), StorageError> {
        let mode = normalize_mode(mode)?;
        self.with_conn(|c| {
            let n = c.execute(
                "UPDATE agents SET manuscript_access_mode = ?2
                 WHERE id = ?1 AND revoked_at IS NULL",
                params![agent_id, mode],
            )?;
            if n == 0 {
                return Err(StorageError::NotFound(format!("active agent {agent_id}")));
            }
            Ok(())
        })
    }

    pub fn list_agent_manuscript_grants(
        &self,
        agent_id: &str,
    ) -> Result<Vec<String>, StorageError> {
        self.with_conn(|c| {
            let mut st = c.prepare(
                "SELECT manuscript_id FROM agent_manuscript_access
                 WHERE agent_id = ?1 ORDER BY granted_at, manuscript_id",
            )?;
            let rows = st
                .query_map([agent_id], |r| r.get(0))?
                .collect::<Result<Vec<String>, _>>()?;
            Ok(rows)
        })
    }

    pub fn grant_agent_manuscript(
        &self,
        agent_id: &str,
        manuscript_id: &str,
    ) -> Result<(), StorageError> {
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
            let exists: Option<i64> = c
                .query_row(
                    "SELECT 1 FROM manuscripts WHERE id = ?1",
                    [manuscript_id],
                    |r| r.get(0),
                )
                .optional()?;
            if exists.is_none() {
                return Err(StorageError::NotFound(format!(
                    "manuscript {manuscript_id}"
                )));
            }
            c.execute(
                &format!(
                    "INSERT INTO agent_manuscript_access (agent_id, manuscript_id, granted_at)
                     VALUES (?1, ?2, {NOW})
                     ON CONFLICT(agent_id, manuscript_id) DO NOTHING"
                ),
                params![agent_id, manuscript_id],
            )?;
            Ok(())
        })
    }

    /// Grant on an open connection (pairing approve transaction).
    pub(crate) fn grant_agent_manuscript_on_conn(
        c: &rusqlite::Connection,
        agent_id: &str,
        manuscript_id: &str,
    ) -> Result<(), StorageError> {
        let exists: Option<i64> = c
            .query_row(
                "SELECT 1 FROM manuscripts WHERE id = ?1",
                [manuscript_id],
                |r| r.get(0),
            )
            .optional()?;
        if exists.is_none() {
            return Err(StorageError::NotFound(format!(
                "manuscript {manuscript_id}"
            )));
        }
        c.execute(
            &format!(
                "INSERT INTO agent_manuscript_access (agent_id, manuscript_id, granted_at)
                 VALUES (?1, ?2, {NOW})
                 ON CONFLICT(agent_id, manuscript_id) DO NOTHING"
            ),
            params![agent_id, manuscript_id],
        )?;
        Ok(())
    }

    pub fn revoke_agent_manuscript(
        &self,
        agent_id: &str,
        manuscript_id: &str,
    ) -> Result<(), StorageError> {
        self.with_conn(|c| {
            c.execute(
                "DELETE FROM agent_manuscript_access WHERE agent_id = ?1 AND manuscript_id = ?2",
                params![agent_id, manuscript_id],
            )?;
            Ok(())
        })
    }

    pub fn revoke_all_agent_manuscripts(&self, agent_id: &str) -> Result<(), StorageError> {
        self.with_conn(|c| {
            c.execute(
                "DELETE FROM agent_manuscript_access WHERE agent_id = ?1",
                [agent_id],
            )?;
            Ok(())
        })
    }

    pub fn agent_can_access_manuscript(
        &self,
        agent_id: &str,
        manuscript_id: &str,
    ) -> Result<bool, StorageError> {
        self.with_conn(|c| {
            let mode: Option<String> = c
                .query_row(
                    "SELECT manuscript_access_mode FROM agents
                     WHERE id = ?1 AND revoked_at IS NULL",
                    [agent_id],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(mode) = mode else {
                return Ok(false);
            };
            if mode == ACCESS_MODE_ALL {
                return Ok(true);
            }
            let granted: Option<i64> = c
                .query_row(
                    "SELECT 1 FROM agent_manuscript_access
                     WHERE agent_id = ?1 AND manuscript_id = ?2",
                    params![agent_id, manuscript_id],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(granted.is_some())
        })
    }

    pub fn list_agents_draft_access(&self) -> Result<Vec<AgentDraftAccess>, StorageError> {
        self.with_conn(|c| {
            let mut st = c.prepare(
                "SELECT id, manuscript_access_mode FROM agents
                 WHERE revoked_at IS NULL ORDER BY created_at, id",
            )?;
            let agents = st
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            let mut out = Vec::with_capacity(agents.len());
            for (agent_id, mode) in agents {
                let mut st2 = c.prepare(
                    "SELECT manuscript_id FROM agent_manuscript_access
                     WHERE agent_id = ?1 ORDER BY granted_at, manuscript_id",
                )?;
                let ids = st2
                    .query_map([&agent_id], |r| r.get(0))?
                    .collect::<Result<Vec<String>, _>>()?;
                out.push(AgentDraftAccess {
                    agent_id,
                    mode,
                    manuscript_ids: ids,
                });
            }
            Ok(out)
        })
    }

    pub fn bulk_grant_manuscript(
        &self,
        agent_ids: &[String],
        manuscript_id: &str,
    ) -> Result<(), StorageError> {
        self.with_conn_mut_storage(|c| {
            let tx = c.transaction()?;
            for agent_id in agent_ids {
                let active: Option<i64> = tx
                    .query_row(
                        "SELECT 1 FROM agents WHERE id = ?1 AND revoked_at IS NULL",
                        [agent_id],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(StorageError::from)?;
                if active.is_none() {
                    return Err(StorageError::NotFound(format!("active agent {agent_id}")));
                }
                Store::grant_agent_manuscript_on_conn(&tx, agent_id, manuscript_id)?;
            }
            tx.commit()?;
            Ok(())
        })
    }

    pub fn bulk_grant_all_manuscripts(&self, agent_ids: &[String]) -> Result<(), StorageError> {
        self.with_conn_mut_storage(|c| {
            let tx = c.transaction()?;
            for agent_id in agent_ids {
                let n = tx.execute(
                    "UPDATE agents SET manuscript_access_mode = ?2
                     WHERE id = ?1 AND revoked_at IS NULL",
                    params![agent_id, ACCESS_MODE_ALL],
                )?;
                if n == 0 {
                    return Err(StorageError::NotFound(format!("active agent {agent_id}")));
                }
            }
            tx.commit()?;
            Ok(())
        })
    }

    pub fn bulk_revoke_all_draft_access(&self, agent_ids: &[String]) -> Result<(), StorageError> {
        self.with_conn_mut_storage(|c| {
            let tx = c.transaction()?;
            for agent_id in agent_ids {
                let n = tx.execute(
                    "UPDATE agents SET manuscript_access_mode = ?2
                     WHERE id = ?1 AND revoked_at IS NULL",
                    params![agent_id, ACCESS_MODE_SELECTED],
                )?;
                if n == 0 {
                    return Err(StorageError::NotFound(format!("active agent {agent_id}")));
                }
                tx.execute(
                    "DELETE FROM agent_manuscript_access WHERE agent_id = ?1",
                    [agent_id],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn store() -> (tempfile::TempDir, Store) {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().to_path_buf();
        (tmp, Store::open(&path).unwrap())
    }

    #[test]
    fn selected_mode_requires_grant() {
        let (_t, s) = store();
        let a = s.create_agent("Bot", "#3366ff").unwrap();
        let m = s.create_manuscript("Draft").unwrap();
        assert!(!s.agent_can_access_manuscript(&a.id, &m.id).unwrap());
        s.grant_agent_manuscript(&a.id, &m.id).unwrap();
        assert!(s.agent_can_access_manuscript(&a.id, &m.id).unwrap());
    }

    #[test]
    fn all_mode_includes_future_manuscripts() {
        let (_t, s) = store();
        let a = s.create_agent("Bot", "#3366ff").unwrap();
        s.set_agent_manuscript_access_mode(&a.id, ACCESS_MODE_ALL)
            .unwrap();
        let m = s.create_manuscript("Later").unwrap();
        assert!(s.agent_can_access_manuscript(&a.id, &m.id).unwrap());
    }

    #[test]
    fn bulk_revoke_clears_grants_and_selected_mode() {
        let (_t, s) = store();
        let a = s.create_agent("Bot", "#3366ff").unwrap();
        let m = s.create_manuscript("One").unwrap();
        s.grant_agent_manuscript(&a.id, &m.id).unwrap();
        s.bulk_revoke_all_draft_access(std::slice::from_ref(&a.id))
            .unwrap();
        assert_eq!(
            s.agent_manuscript_access_mode(&a.id).unwrap(),
            ACCESS_MODE_SELECTED
        );
        assert!(!s.agent_can_access_manuscript(&a.id, &m.id).unwrap());
    }
}
