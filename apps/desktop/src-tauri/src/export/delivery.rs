//! Save exported files through the native save dialog (#242).

use std::fs;
use std::io::{Error, ErrorKind};
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Window};
use tauri_plugin_dialog::DialogExt;

use super::ExportJob;
#[cfg(any(windows, target_os = "macos"))]
use crate::save_copy::display_path_str;
use crate::save_copy::{check_write_dest, display_path};
use crate::storage::Store;

pub fn default_export_file_name(title: &str, ext: &str) -> String {
    let safe: String = title
        .chars()
        .map(|c| {
            if c.is_control() || r#"\/:*?"<>|"#.contains(c) {
                ' '
            } else {
                c
            }
        })
        .collect();
    let safe = safe.trim().trim_matches('.');
    let safe: String = safe.chars().take(120).collect();
    let stem = if safe.is_empty() { "Manuscript" } else { &safe };
    format!("{stem}.{ext}")
}

fn data_dirs(app: &AppHandle, store: &Store) -> Vec<PathBuf> {
    let mut dirs = vec![store.data_dir().to_path_buf()];
    dirs.extend(app.path().app_data_dir().ok());
    dirs.extend(app.path().app_local_data_dir().ok());
    dirs
}

fn default_save_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().document_dir().ok()
}

/// Copy a finished export job's output through a parented save dialog. Returns the display path
/// written, or `None` when the user cancels.
pub fn save_export_via_dialog(
    app: &AppHandle,
    window: &Window,
    store: &Store,
    job: &ExportJob,
) -> Result<Option<String>, String> {
    let src = job
        .file_path
        .as_ref()
        .ok_or_else(|| "export has no output file yet".to_string())?;
    let src = PathBuf::from(src);
    if !src.is_file() {
        return Err("export output file is missing".into());
    }
    let ext = job.format.as_str();
    let filter_name = if ext == "epub" {
        "EPUB"
    } else {
        "Word document"
    };
    let filter_ext = if ext == "epub" {
        &["epub"][..]
    } else {
        &["docx"][..]
    };
    let default_name = default_export_file_name(
        src.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Manuscript"),
        ext,
    );
    let dirs = data_dirs(app, store);
    let picked = app
        .dialog()
        .file()
        .set_parent(window)
        .set_title("Save export")
        .set_file_name(&default_name)
        .add_filter(filter_name, filter_ext);
    let picked = if let Some(dir) = default_save_dir(app) {
        picked.set_directory(dir)
    } else {
        picked
    }
    .blocking_save_file();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let dest = picked.into_path().map_err(|e| format!("io: {e}"))?;
    let dest = check_write_dest(&dirs, &dest, ext, "export").map_err(|e| format!("io: {e}"))?;
    fs::copy(&src, &dest).map_err(|e| format!("io: {e}"))?;
    Ok(Some(display_path(&dest)))
}

pub fn reveal_in_file_manager(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err("path must be absolute".into());
    }
    #[cfg(target_os = "windows")]
    {
        let shown = display_path_str(path);
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", shown))
            .spawn()
            .map_err(|e| format!("io: {e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let shown = display_path_str(path);
        std::process::Command::new("open")
            .arg("-R")
            .arg(shown)
            .spawn()
            .map_err(|e| format!("io: {e}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = p
            .parent()
            .ok_or_else(|| Error::new(ErrorKind::InvalidInput, "no folder").to_string())?;
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| format!("io: {e}"))?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("unsupported platform".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_name_sanitizes_title() {
        assert_eq!(
            default_export_file_name("Memory/Wipe", "docx"),
            "Memory Wipe.docx"
        );
    }
}
