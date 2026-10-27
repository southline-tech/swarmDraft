//! "Save a copy" from the save-failure banner (#62, mockup ob9).
//!
//! The frontend builds a .docx of the manuscript as it is in memory (including edits the
//! database has not taken yet) and hands only the bytes here. The destination is picked in the
//! native save dialog opened from Rust, so no script in the webview can choose where a file is
//! written. The copy is written atomically: to a temp file in the same folder, synced, then
//! renamed into place, so a failure never leaves a half-written file or a damaged original.
//! Paths inside the app's data folders are refused so a copy can never replace app storage.

use std::fs::File;
use std::io::{Error, ErrorKind, Write};
use std::path::{Component, Path, PathBuf};

/// True when `path` is `root` or inside it. On Windows paths compare case-insensitively.
fn is_within(path: &Path, root: &Path, case_insensitive: bool) -> bool {
    let norm = |p: &Path| -> Vec<String> {
        p.components()
            .map(|c| {
                let s = c.as_os_str().to_string_lossy().into_owned();
                if case_insensitive {
                    s.to_lowercase()
                } else {
                    s
                }
            })
            .collect()
    };
    let (p, r) = (norm(path), norm(root));
    p.len() >= r.len() && p[..r.len()] == r[..]
}

/// True for UNC and admin-share forms (`\\\\server\\share`, `\\\\localhost\\C$`,
/// `\\\\?\\UNC\\...`, and the same with forward slashes). Their canonical form never
/// prefix-matches the drive-letter data folder, so they are refused outright.
pub(crate) fn is_unc_like(s: &str) -> bool {
    let s = s.replace('/', "\\");
    if s.get(..8)
        .is_some_and(|h| h.eq_ignore_ascii_case("\\\\?\\UNC\\"))
    {
        return true;
    }
    if s.starts_with("\\\\?\\") || s.starts_with("\\\\.\\") {
        // Verbatim/device drive paths (`\\?\C:\...`) are local; anything else is not.
        let rest = s.get(4..).unwrap_or("");
        let b = rest.as_bytes();
        return !(b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':');
    }
    s.starts_with("\\\\")
}

/// Check `dest` and return the real path the copy will be written to.
pub fn check_dest(data_dirs: &[PathBuf], dest: &Path) -> std::io::Result<PathBuf> {
    check_write_dest(data_dirs, dest, "docx", "copy")
}

/// Shared destination check for every user-picked write (save a copy #65, backup #73).
///
/// Refuses relative paths, UNC / admin-share paths, `.`/`..` components, a file name not
/// ending in `.{ext}`, a missing parent folder, a destination that is itself a symlink, and
/// anything that resolves (after canonicalizing the parent, so symlinks and junctions are
/// followed) into one of `data_dirs`. `what` names the file in error messages.
pub fn check_write_dest(
    data_dirs: &[PathBuf],
    dest: &Path,
    ext: &str,
    what: &str,
) -> std::io::Result<PathBuf> {
    let invalid = |m: String| Error::new(ErrorKind::InvalidInput, m);
    let denied = |m: String| Error::new(ErrorKind::PermissionDenied, m);
    if !dest.is_absolute() {
        return Err(invalid(format!("{what} path must be absolute")));
    }
    if is_unc_like(&dest.to_string_lossy()) {
        return Err(denied(format!(
            "permission denied: {what} path is a network share"
        )));
    }
    if dest
        .components()
        .any(|c| matches!(c, Component::CurDir | Component::ParentDir))
    {
        return Err(invalid(format!("{what} path must not contain . or ..")));
    }
    let name = dest
        .file_name()
        .ok_or_else(|| invalid(format!("{what} path has no file name")))?;
    let ext_ok = Path::new(name)
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case(ext));
    if !ext_ok {
        return Err(invalid(format!("{what} must be a .{ext} file")));
    }
    let parent = dest
        .parent()
        .ok_or_else(|| invalid(format!("{what} path has no folder")))?;
    // Fails if the folder does not exist.
    let parent = parent.canonicalize()?;
    let real = parent.join(name);
    if std::fs::symlink_metadata(&real).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(denied(format!("permission denied: {what} path is a link")));
    }
    if is_unc_like(&real.to_string_lossy()) {
        return Err(denied(format!(
            "permission denied: {what} path is a network share"
        )));
    }
    let ci = cfg!(windows);
    for dir in data_dirs {
        let dir = dir.canonicalize().unwrap_or_else(|_| dir.clone());
        if is_within(&real, &dir, ci) {
            return Err(denied(format!(
                "permission denied: {what} path is inside the app data folder"
            )));
        }
    }
    Ok(real)
}

/// Write `bytes` to `dest` atomically after [`check_dest`].
pub fn write_copy(data_dirs: &[PathBuf], dest: &Path, bytes: &[u8]) -> std::io::Result<PathBuf> {
    write_copy_with(data_dirs, dest, bytes, |f, b| f.write_all(b))
}

/// [`write_copy`] with the byte writer injectable, so tests can fail a write halfway.
fn write_copy_with(
    data_dirs: &[PathBuf],
    dest: &Path,
    bytes: &[u8],
    write: impl FnOnce(&mut File, &[u8]) -> std::io::Result<()>,
) -> std::io::Result<PathBuf> {
    let real = check_dest(data_dirs, dest)?;
    let dir = real
        .parent()
        .ok_or_else(|| Error::new(ErrorKind::InvalidInput, "copy path has no folder"))?;
    // Dropping the NamedTempFile on any error below deletes the temp file.
    let mut tmp = tempfile::Builder::new()
        .prefix(".save-copy-")
        .suffix(".tmp")
        .tempfile_in(dir)?;
    write(tmp.as_file_mut(), bytes)?;
    tmp.as_file().sync_all()?;
    // The save dialog already asked the user to confirm Replace for an existing file.
    tmp.persist(&real).map_err(|e| e.error)?;
    Ok(real)
}

/// A safe default file name for the save dialog from the manuscript title.
pub fn default_file_name(title: &str) -> String {
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
    let safe = safe.trim().trim_matches('.').trim();
    let safe: String = safe.chars().take(120).collect();
    let safe = if safe.is_empty() { "Manuscript" } else { &safe };
    format!("{safe} (copy).docx")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dirs(d: &tempfile::TempDir) -> Vec<PathBuf> {
        vec![d.path().to_path_buf()]
    }

    #[test]
    fn writes_the_bytes_and_leaves_no_temp_file() {
        let data = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("book.docx");
        write_copy(&dirs(&data), &dest, b"hello").unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello");
        assert_eq!(std::fs::read_dir(out.path()).unwrap().count(), 1);
    }

    #[test]
    fn replaces_an_existing_file_the_user_confirmed() {
        let data = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("book.docx");
        std::fs::write(&dest, b"old").unwrap();
        write_copy(&dirs(&data), &dest, b"new").unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"new");
    }

    #[test]
    fn a_write_failing_halfway_leaves_the_original_and_no_temp_file() {
        let data = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("book.docx");
        std::fs::write(&dest, b"original").unwrap();
        let err = write_copy_with(&dirs(&data), &dest, b"new contents", |f, b| {
            f.write_all(&b[..b.len() / 2])?;
            Err(Error::other("disk full"))
        })
        .unwrap_err();
        assert_eq!(err.to_string(), "disk full");
        assert_eq!(std::fs::read(&dest).unwrap(), b"original");
        let names: Vec<_> = std::fs::read_dir(out.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("book.docx")]);
    }

    #[test]
    fn refuses_paths_inside_the_data_folder() {
        let data = tempfile::tempdir().unwrap();
        let db = data.path().join("coauthor.docx");
        std::fs::write(&db, b"db").unwrap();
        let err = write_copy(&dirs(&data), &db, b"x").unwrap_err();
        assert_eq!(err.kind(), ErrorKind::PermissionDenied);
        assert_eq!(std::fs::read(&db).unwrap(), b"db");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_destination_that_is_itself_a_link() {
        let out = tempfile::tempdir().unwrap();
        let target = out.path().join("target.docx");
        std::fs::write(&target, b"keep").unwrap();
        let link = out.path().join("link.docx");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let err = write_copy(&[], &link, b"x").unwrap_err();
        assert_eq!(err.kind(), ErrorKind::PermissionDenied);
        assert_eq!(std::fs::read(&target).unwrap(), b"keep");
    }

    #[test]
    fn refuses_network_share_paths() {
        for p in ["//server/share/a.docx", "//localhost/C$/a.docx"] {
            let err = check_dest(&[], Path::new(p)).unwrap_err();
            assert!(
                matches!(
                    err.kind(),
                    ErrorKind::PermissionDenied | ErrorKind::InvalidInput
                ),
                "{p}"
            );
        }
        assert!(is_unc_like(r"\\localhost\C$\a.docx"));
    }

    #[test]
    fn refuses_the_second_data_folder_too() {
        let roaming = tempfile::tempdir().unwrap();
        let local = tempfile::tempdir().unwrap();
        let both = vec![roaming.path().to_path_buf(), local.path().to_path_buf()];
        let err = check_dest(&both, &local.path().join("x.docx")).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::PermissionDenied);
    }

    #[test]
    fn refuses_dot_dot_bypasses_into_the_data_folder() {
        let data = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        // <out>/nope/../../<data name>/book.docx: "nope" does not exist.
        let rel = data
            .path()
            .strip_prefix(data.path().parent().unwrap())
            .unwrap();
        let bypass = out
            .path()
            .join("nope")
            .join("..")
            .join("..")
            .join(rel)
            .join("book.docx");
        assert_eq!(
            check_dest(&dirs(&data), &bypass).unwrap_err().kind(),
            ErrorKind::InvalidInput
        );
        let dot = data.path().join(".").join("book.docx");
        assert!(check_dest(&dirs(&data), &dot).is_err());
        let up = out.path().join("..").join("book.docx");
        assert!(check_dest(&dirs(&data), &up).is_err());
        assert!(!data.path().join("book.docx").exists());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlinked_folder_that_points_into_the_data_folder() {
        let data = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let link = out.path().join("link");
        std::os::unix::fs::symlink(data.path(), &link).unwrap();
        let err = check_dest(&dirs(&data), &link.join("book.docx")).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::PermissionDenied);
    }

    #[test]
    fn data_folder_match_ignores_case_on_windows() {
        let root = Path::new("/Users/A/AppData/Local/App");
        let p = Path::new("/users/a/appdata/LOCAL/app/coauthor.docx");
        assert!(is_within(p, root, true));
        assert!(!is_within(p, root, false));
        assert!(!is_within(
            Path::new("/Users/A/AppData/Local/Apple/x.docx"),
            root,
            true
        ));
    }

    #[test]
    fn refuses_a_missing_folder_relative_paths_and_non_docx() {
        let data = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let missing = out.path().join("missing-folder").join("book.docx");
        assert!(write_copy(&dirs(&data), &missing, b"x").is_err());
        assert!(!missing.exists());
        assert!(write_copy(&dirs(&data), Path::new("book.docx"), b"x").is_err());
        for name in ["book.exe", "book.docx.bat", "book", "book.DOCX.lnk"] {
            let p = out.path().join(name);
            assert!(write_copy(&dirs(&data), &p, b"x").is_err(), "{name}");
            assert!(!p.exists());
        }
        assert!(write_copy(&dirs(&data), &out.path().join("Book.DOCX"), b"x").is_ok());
    }

    #[test]
    fn default_file_name_is_safe() {
        assert_eq!(default_file_name("My Book"), "My Book (copy).docx");
        assert_eq!(default_file_name("../a\\b:c"), "a b c (copy).docx");
        assert_eq!(default_file_name("  "), "Manuscript (copy).docx");
    }
}
