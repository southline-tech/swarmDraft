//! Human editing-session records stored in the git worktree (`sessions/<id>.json`).

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::repo::DraftRepoError;
use super::sync::{to_pretty, write_stable};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: String,
    pub author_name: String,
    pub started_at: String,
    pub base_commit: Option<String>,
    pub ended_at: Option<String>,
}

pub fn session_path(
    worktree: &Path,
    session_id: &str,
) -> Result<std::path::PathBuf, DraftRepoError> {
    if !safe_file_id(session_id) {
        return Err(DraftRepoError::Invalid(format!(
            "unsafe session id: {session_id}"
        )));
    }
    Ok(worktree.join("sessions").join(format!("{session_id}.json")))
}

pub fn write_session_file(worktree: &Path, record: &SessionRecord) -> Result<(), DraftRepoError> {
    let path = session_path(worktree, &record.id)?;
    let bytes = to_pretty(record)?;
    write_stable(&path, &bytes)
}

pub fn safe_file_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}
