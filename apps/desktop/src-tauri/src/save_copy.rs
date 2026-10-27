//! "Save a copy" from the save-failure banner (#62, mockup ob9).
//!
//! The frontend builds a .docx of the manuscript as it is in memory (including edits the
//! database has not taken yet) and hands the bytes here with a path the user picked in the
//! native save dialog. The copy is written atomically: to a temp file in the same folder,
//! synced, then renamed into place, so a failure never leaves a half-written file. Paths inside
//! the app's data folder are refused so a copy can never replace the app's own storage.

use std::io::Write;
use std::path::{Path, PathBuf};

/// Resolve `p` as far as it exists on disk (the file itself may not exist yet).
fn resolve(p: &Path) -> PathBuf {
    if let Ok(c) = p.canonicalize() {
        return c;
    }
    match (p.parent(), p.file_name()) {
        (Some(parent), Some(name)) if !parent.as_os_str().is_empty() => resolve(parent).join(name),
        _ => p.to_path_buf(),
    }
}

/// Write `bytes` to `dest` atomically. Refuses relative paths and anything inside `data_dir`.
pub fn write_copy(data_dir: &Path, dest: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::{Error, ErrorKind};
    if !dest.is_absolute() {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            "copy path must be absolute",
        ));
    }
    if resolve(dest).starts_with(resolve(data_dir)) {
        return Err(Error::new(
            ErrorKind::PermissionDenied,
            "permission denied: copy path is inside the app data folder",
        ));
    }
    let dir = dest
        .parent()
        .ok_or_else(|| Error::new(ErrorKind::InvalidInput, "copy path has no folder"))?;
    let mut tmp = tempfile::Builder::new()
        .prefix(".save-copy-")
        .suffix(".tmp")
        .tempfile_in(dir)?;
    tmp.write_all(bytes)?;
    tmp.as_file().sync_all()?;
    // The save dialog already asked the user to confirm Replace for an existing file.
    tmp.persist(dest).map_err(|e| e.error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_the_bytes_and_leaves_no_temp_file() {
        let data = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("book.docx");
        write_copy(data.path(), &dest, b"hello").unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello");
        assert_eq!(std::fs::read_dir(out.path()).unwrap().count(), 1);
    }

    #[test]
    fn replaces_an_existing_file_the_user_confirmed() {
        let data = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("book.docx");
        std::fs::write(&dest, b"old").unwrap();
        write_copy(data.path(), &dest, b"new").unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"new");
    }

    #[test]
    fn refuses_paths_inside_the_data_folder() {
        let data = tempfile::tempdir().unwrap();
        let db = data.path().join("coauthor.db");
        std::fs::write(&db, b"db").unwrap();
        let err = write_copy(data.path(), &db, b"x").unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
        assert_eq!(std::fs::read(&db).unwrap(), b"db");
        let nested = data.path().join("sub").join("..").join("new.docx");
        assert!(write_copy(data.path(), &nested, b"x").is_err());
    }

    #[test]
    fn refuses_relative_paths() {
        let data = tempfile::tempdir().unwrap();
        assert!(write_copy(data.path(), Path::new("book.docx"), b"x").is_err());
    }

    #[test]
    fn a_failed_write_leaves_the_existing_file_alone() {
        let data = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("missing-folder").join("book.docx");
        assert!(write_copy(data.path(), &dest, b"x").is_err());
        assert!(!dest.exists());
    }
}
