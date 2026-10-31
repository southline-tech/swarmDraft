//! Export job persistence (#39).

use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use crate::manuscripts::NOW;
use crate::storage::{StorageError, Store};

pub const EXPORT_FORMATS: &[&str] = &["epub", "docx", "pdf"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportJob {
    pub id: String,
    pub manuscript_id: String,
    pub format: String,
    pub trim: Option<String>,
    pub status: String,
    pub file_path: Option<String>,
    pub error_message: Option<String>,
    pub log: Option<String>,
    pub created_at: String,
    pub finished_at: Option<String>,
}

fn row_job(r: &rusqlite::Row<'_>) -> rusqlite::Result<ExportJob> {
    Ok(ExportJob {
        id: r.get(0)?,
        manuscript_id: r.get(1)?,
        format: r.get(2)?,
        trim: r.get(3)?,
        status: r.get(4)?,
        file_path: r.get(5)?,
        error_message: r.get(6)?,
        log: r.get(7)?,
        created_at: r.get(8)?,
        finished_at: r.get(9)?,
    })
}

const JOB_COLS: &str = "id, manuscript_id, format, trim, status, file_path, error_message, log, created_at, finished_at";

impl Store {
    pub fn create_export_job(
        &self,
        manuscript_id: &str,
        format: &str,
        trim: Option<&str>,
    ) -> Result<ExportJob, StorageError> {
        if !EXPORT_FORMATS.contains(&format) {
            return Err(StorageError::Invalid(format!(
                "unknown export format: {format}"
            )));
        }
        self.get_manuscript(manuscript_id)?;
        let id = crate::manuscripts::new_id();
        self.with_conn(|c| {
            c.execute(
                &format!(
                    "INSERT INTO export_jobs (id, manuscript_id, format, trim, status, created_at) \
                     VALUES (?1, ?2, ?3, ?4, 'queued', {NOW})"
                ),
                params![id, manuscript_id, format, trim],
            )?;
            Ok(c.query_row(
                &format!("SELECT {JOB_COLS} FROM export_jobs WHERE id = ?1"),
                [&id],
                row_job,
            )?)
        })
    }

    pub fn get_export_job(&self, job_id: &str) -> Result<ExportJob, StorageError> {
        self.with_conn(|c| {
            c.query_row(
                &format!("SELECT {JOB_COLS} FROM export_jobs WHERE id = ?1"),
                [job_id],
                row_job,
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound(format!("export job {job_id}")))
        })
    }

    pub fn list_export_jobs(
        &self,
        manuscript_id: &str,
        limit: usize,
    ) -> Result<Vec<ExportJob>, StorageError> {
        self.get_manuscript(manuscript_id)?;
        self.with_conn(|c| {
            let mut st = c.prepare(&format!(
                "SELECT {JOB_COLS} FROM export_jobs WHERE manuscript_id = ?1 \
                 ORDER BY created_at DESC, id DESC LIMIT ?2"
            ))?;
            let rows = st
                .query_map(params![manuscript_id, limit as i64], row_job)?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    pub(crate) fn set_export_job_running(&self, job_id: &str) -> Result<(), StorageError> {
        self.with_conn(|c| {
            let n = c.execute(
                "UPDATE export_jobs SET status = 'running' WHERE id = ?1 AND status = 'queued'",
                [job_id],
            )?;
            if n == 0 {
                return Err(StorageError::Invalid(format!(
                    "export job {job_id} is not queued"
                )));
            }
            Ok(())
        })
    }

    pub(crate) fn finish_export_job(
        &self,
        job_id: &str,
        file_path: Option<&str>,
        error_message: Option<&str>,
        log: Option<&str>,
    ) -> Result<(), StorageError> {
        let status = if error_message.is_none() && file_path.is_some() {
            "succeeded"
        } else {
            "failed"
        };
        self.with_conn(|c| {
            c.execute(
                &format!(
                    "UPDATE export_jobs SET status = ?2, file_path = ?3, error_message = ?4, \
                     log = ?5, finished_at = {NOW} WHERE id = ?1"
                ),
                params![job_id, status, file_path, error_message, log],
            )?;
            Ok(())
        })
    }

    pub fn exports_dir(&self) -> std::path::PathBuf {
        self.data_dir().join("exports")
    }
}
