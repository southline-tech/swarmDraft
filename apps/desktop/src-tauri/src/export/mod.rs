//! Export orchestration: AST → Pandoc → files under app data (#39).

mod ast;
mod jobs;
mod markdown;
mod pandoc;

pub use ast::{build_manuscript_ast, is_book_manuscript, ManuscriptAst};
pub use jobs::{ExportJob, EXPORT_FORMATS};
pub use pandoc::{locate_pandoc, PANDOC_MISSING, PDF_NOT_IN_BUILD};

use std::path::PathBuf;

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
) -> Result<ExportJob, StorageError> {
    validate_export_format(format)?;
    let job = store.create_export_job(manuscript_id, format, trim)?;
    let store = store.clone();
    let job_id = job.id.clone();
    std::thread::spawn(move || {
        if let Err(e) = run_export_job(&store, &job_id) {
            eprintln!("export job {job_id} failed: {e}");
        }
    });
    Ok(job)
}

fn run_export_job(store: &Store, job_id: &str) -> Result<(), StorageError> {
    let job = store.get_export_job(job_id)?;
    if job.status != "queued" {
        return Ok(());
    }
    store.set_export_job_running(job_id)?;
    let result = execute_export(store, &job);
    match result {
        Ok((path, log)) => {
            store.finish_export_job(job_id, Some(&path.display().to_string()), None, Some(&log))?
        }
        Err(msg) => store.finish_export_job(job_id, None, Some(&msg), None)?,
    }
    Ok(())
}

fn execute_export(store: &Store, job: &ExportJob) -> Result<(PathBuf, String), String> {
    if job.format == "pdf" {
        return Err(PDF_NOT_IN_BUILD.into());
    }
    let pandoc = pandoc::locate_pandoc()?;
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
        if pandoc::locate_pandoc().is_err() {
            eprintln!("skipping end_to_end_export_with_pandoc: pandoc not installed");
            return;
        }
        let job = store.create_export_job(&m.id, "epub", None).unwrap();
        run_export_job(&store, &job.id).unwrap();
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
        let job = store.create_export_job(&m.id, "docx", None).unwrap();
        if pandoc::locate_pandoc().is_ok() {
            return;
        }
        run_export_job(&store, &job.id).unwrap();
        let done = store.get_export_job(&job.id).unwrap();
        assert_eq!(done.status, "failed");
        assert!(done
            .error_message
            .as_deref()
            .unwrap_or("")
            .contains("Pandoc"));
    }
}
