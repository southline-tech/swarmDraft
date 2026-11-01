//! Export orchestration: AST → Pandoc → files under app data (#39, #186).

mod ast;
pub mod delivery;
mod jobs;
mod markdown;
mod pandoc;

pub use ast::{build_manuscript_ast, is_book_manuscript, ManuscriptAst};
pub use jobs::{ExportJob, EXPORT_FORMATS};
pub use pandoc::{
    locate_pandoc, managed_pandoc_exe, resolve_pandoc, PandocDownloadState, PandocDownloadStatus,
    PANDOC_MISSING, PDF_NOT_IN_BUILD,
};

use std::path::{Path, PathBuf};

use crate::storage::{StorageError, Store};

pub fn validate_export_format(format: &str) -> Result<(), StorageError> {
    if format == "pdf" {
        return Err(StorageError::Invalid(PDF_NOT_IN_BUILD.into()));
    }
    if !EXPORT_FORMATS.contains(&format) {
        return Err(StorageError::Invalid(format!(
            "unknown export format: {format}"
        )));
    }
    Ok(())
}

pub fn trigger_export(
    store: &Store,
    manuscript_id: &str,
    format: &str,
    trim: Option<&str>,
    pandoc_override: Option<&str>,
    download: Option<&PandocDownloadState>,
) -> Result<ExportJob, StorageError> {
    validate_export_format(format)?;
    let job = store.create_export_job(manuscript_id, format, trim)?;
    let store = store.clone();
    let job_id = job.id.clone();
    let pandoc_override = pandoc_override.map(|s| s.to_string());
    let download = download.cloned();
    std::thread::spawn(move || {
        if let Err(e) = run_export_job(
            &store,
            &job_id,
            pandoc_override.as_deref(),
            download.as_ref(),
        ) {
            eprintln!("export job {job_id} failed: {e}");
        }
    });
    Ok(job)
}

fn run_export_job(
    store: &Store,
    job_id: &str,
    pandoc_override: Option<&str>,
    download: Option<&PandocDownloadState>,
) -> Result<(), StorageError> {
    let job = store.get_export_job(job_id)?;
    if job.status != "queued" {
        return Ok(());
    }
    store.set_export_job_running(job_id)?;
    let result = execute_export(store, &job, pandoc_override, download);
    if let Some(d) = download {
        d.clear();
    }
    match result {
        Ok((path, log)) => {
            store.finish_export_job(job_id, Some(&path.display().to_string()), None, Some(&log))?
        }
        Err(msg) => store.finish_export_job(job_id, None, Some(&msg), None)?,
    }
    Ok(())
}

fn execute_export(
    store: &Store,
    job: &ExportJob,
    pandoc_override: Option<&str>,
    download: Option<&PandocDownloadState>,
) -> Result<(PathBuf, String), String> {
    if job.format == "pdf" {
        return Err(PDF_NOT_IN_BUILD.into());
    }
    let override_path = pandoc_override
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(Path::new);
    let pandoc = resolve_pandoc(store.data_dir(), override_path, download)?;
    let ast = build_manuscript_ast(store, &job.manuscript_id).map_err(|e| e.to_string())?;
    let md = markdown::manuscript_to_markdown(&ast);
    let job_dir = store.exports_dir().join(&job.id);
    std::fs::create_dir_all(&job_dir).map_err(|e| e.to_string())?;
    let md_path = job_dir.join("manuscript.md");
    std::fs::write(&md_path, md).map_err(|e| e.to_string())?;
    let assets = job_dir.join("assets");
    let css = pandoc::write_theme_css(&assets)?;
    let reference = pandoc::write_reference_docx(&assets)?;
    let ext = if job.format == "epub" { "epub" } else { "docx" };
    let safe_title = sanitize_filename(&ast.title);
    let out_path = job_dir.join(format!("{safe_title}.{ext}"));
    let log = pandoc::run_pandoc(&pandoc, &md_path, &out_path, &job.format, &css, &reference)?;
    Ok((out_path, log))
}

fn sanitize_filename(title: &str) -> String {
    let mut s: String = title
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else if c.is_whitespace() {
                '-'
            } else {
                '_'
            }
        })
        .collect();
    if s.is_empty() {
        s = "manuscript".into();
    }
    if s.len() > 80 {
        s.truncate(80);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdf_format_is_rejected_up_front() {
        let err = validate_export_format("pdf").unwrap_err();
        assert!(err.to_string().contains("PDF export"));
    }

    #[test]
    fn end_to_end_export_with_pandoc() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let m = store.create_manuscript("Pandoc Test").unwrap();
        store
            .import_section_json(
                &m.id,
                "chapter",
                "One",
                &serde_json::json!({"type":"doc","content":[{"type":"paragraph","attrs":{"style":"body"},"content":[{"type":"text","text":"Export line."}]}]}),
            )
            .unwrap();
        if resolve_pandoc(dir.path(), None, None).is_err() {
            eprintln!("skipping end_to_end_export_with_pandoc: pandoc not available");
            return;
        }
        let job = store.create_export_job(&m.id, "epub", None).unwrap();
        run_export_job(&store, &job.id, None, None).unwrap();
        let done = store.get_export_job(&job.id).unwrap();
        assert_eq!(done.status, "succeeded", "{:?}", done.error_message);
        assert!(done.file_path.as_ref().unwrap().ends_with(".epub"));
    }

    #[test]
    fn missing_pandoc_marks_job_failed() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let m = store.create_manuscript("No Pandoc").unwrap();
        store
            .import_section_json(
                &m.id,
                "chapter",
                "One",
                &serde_json::json!({"type":"doc","content":[{"type":"paragraph","attrs":{"style":"body"},"content":[{"type":"text","text":"x"}]}]}),
            )
            .unwrap();
        if resolve_pandoc(dir.path(), None, None).is_ok() {
            return;
        }
        let job = store.create_export_job(&m.id, "docx", None).unwrap();
        run_export_job(&store, &job.id, None, None).unwrap();
        let done = store.get_export_job(&job.id).unwrap();
        assert_eq!(done.status, "failed");
        assert!(done
            .error_message
            .as_deref()
            .unwrap_or("")
            .to_lowercase()
            .contains("pandoc"));
    }

    #[test]
    fn pandoc_root_dir_is_under_data_dir() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        assert_eq!(store.pandoc_root_dir(), dir.path().join("pandoc"));
    }
}
