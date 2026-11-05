//! Relocate linked `.draft` paths that still point at legacy coAuthor folders or aren't writable (#331).

use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use crate::migrate::{old_dir_for, LEGACY_COAUTHOR_IDENTIFIER};
use crate::storage::Store;

use super::service::{sanitize_filename, unique_draft_path};

/// True when `path` is under a legacy coAuthor app data folder or names that identifier.
pub fn path_in_legacy_app_folder(
    path: &Path,
    data_dir: &Path,
    local_data_dir: Option<&Path>,
) -> bool {
    let raw = path.to_string_lossy();
    let lower = raw.replace('/', "\\").to_lowercase();
    if lower.contains(LEGACY_COAUTHOR_IDENTIFIER) {
        return true;
    }
    let ci = cfg!(windows);
    let mut roots: Vec<PathBuf> = vec![data_dir.to_path_buf()];
    if let Some(local) = local_data_dir {
        roots.push(local.to_path_buf());
    }
    for root in roots {
        if let Some(old) = old_dir_for(&root) {
            if crate::save_copy::is_path_within(path, &old, ci) {
                return true;
            }
        }
    }
    false
}

/// True when the app can create a new file in `path`'s parent folder.
pub fn parent_is_writable(path: &Path) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    if !parent.is_dir() {
        return false;
    }
    let probe = parent.join(format!(".swarmdraft-write-probe-{}", std::process::id()));
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
    {
        Ok(mut f) => {
            let _ = f.write_all(b"x");
            let _ = f.sync_all();
            let _ = fs::remove_file(&probe);
            true
        }
        Err(e) if e.kind() == ErrorKind::AlreadyExists => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Move linked draft files out of legacy folders into `{data_dir}/drafts/` when needed.
pub fn repair_draft_file_paths(
    store: &Store,
    data_dir: &Path,
    local_data_dir: Option<&Path>,
) -> Result<usize, String> {
    let drafts_dir = data_dir.join("drafts");
    fs::create_dir_all(&drafts_dir).map_err(|e| e.to_string())?;
    let mut moved = 0usize;
    for id in store.list_manuscript_ids().map_err(|e| e.to_string())? {
        let Some(old_path) = store.draft_file_path(&id).map_err(|e| e.to_string())? else {
            continue;
        };
        let old = PathBuf::from(&old_path);
        if !path_in_legacy_app_folder(&old, data_dir, local_data_dir) && parent_is_writable(&old) {
            continue;
        }
        let title = store.get_manuscript(&id).map_err(|e| e.to_string())?.title;
        let base = sanitize_filename(&title);
        let new_path = unique_draft_path(&drafts_dir, &base);
        if old.is_file() {
            fs::copy(&old, &new_path).map_err(|e| format!("copy draft: {e}"))?;
        }
        store
            .set_draft_file_path(&id, &new_path.to_string_lossy())
            .map_err(|e| e.to_string())?;
        moved += 1;
    }
    Ok(moved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Store;
    use tempfile::tempdir;

    #[test]
    fn legacy_path_is_relocated_into_app_drafts_dir() {
        let t = tempdir().unwrap();
        let data = t.path().join("com.radiancelux.swarmdraft");
        fs::create_dir_all(&data).unwrap();
        let store = Store::open(&data).unwrap();
        let stored = store.create_blank_manuscript_with_progress(None).unwrap();
        let legacy = t
            .path()
            .join("com.radiancelux.coauthor")
            .join("CHAPTER ONE.draft");
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::write(&legacy, b"fake draft bytes").unwrap();
        store
            .set_draft_file_path(&stored.manuscript.id, &legacy.to_string_lossy())
            .unwrap();
        assert!(path_in_legacy_app_folder(&legacy, &data, None));
        let n = repair_draft_file_paths(&store, &data, None).unwrap();
        assert_eq!(n, 1);
        let updated = store
            .draft_file_path(&stored.manuscript.id)
            .unwrap()
            .unwrap();
        assert!(updated.contains("com.radiancelux.swarmdraft"));
        assert!(Path::new(&updated).starts_with(data.join("drafts")));
        assert!(Path::new(&updated).is_file());
    }

    #[test]
    fn writable_modern_path_is_unchanged() {
        let t = tempdir().unwrap();
        let data = t.path().join("data");
        fs::create_dir_all(&data).unwrap();
        let store = Store::open(&data).unwrap();
        let stored = store.create_blank_manuscript_with_progress(None).unwrap();
        let drafts = data.join("drafts/book.draft");
        fs::create_dir_all(drafts.parent().unwrap()).unwrap();
        fs::write(&drafts, b"x").unwrap();
        store
            .set_draft_file_path(&stored.manuscript.id, &drafts.to_string_lossy())
            .unwrap();
        assert_eq!(repair_draft_file_paths(&store, &data, None).unwrap(), 0);
    }
}
