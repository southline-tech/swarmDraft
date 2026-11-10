//! Zip container for a `.draft` file (uncompressed entries).

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use zip::read::ZipArchive;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

pub const DRAFT_FORMAT: &str = "swarmdraft-draft";
pub const DRAFT_FORMAT_VERSION: u32 = 2;
pub const MANIFEST_NAME: &str = "manifest.json";
pub const REPO_DIR: &str = "repo.git";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftManifest {
    pub format: String,
    pub format_version: u32,
    pub app_version: String,
    pub book_id: String,
    pub title: String,
}

#[derive(Debug, thiserror::Error)]
pub enum DraftFormatError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("zip: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid draft: {0}")]
    Invalid(String),
}

fn invalid(msg: impl Into<String>) -> DraftFormatError {
    DraftFormatError::Invalid(msg.into())
}

fn store_options() -> SimpleFileOptions {
    SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)
}

pub fn write_manifest(manifest: &DraftManifest) -> Result<Vec<u8>, DraftFormatError> {
    Ok(serde_json::to_vec_pretty(manifest)?)
}

pub fn read_manifest(bytes: &[u8]) -> Result<DraftManifest, DraftFormatError> {
    let m: DraftManifest = serde_json::from_slice(bytes)?;
    if m.format != DRAFT_FORMAT {
        return Err(invalid("unknown draft format"));
    }
    if m.format_version != DRAFT_FORMAT_VERSION {
        return Err(invalid("unsupported format version"));
    }
    Ok(m)
}

/// Pack `repo_dir` (bare git) and manifest into `dest` atomically.
pub fn pack_draft(
    dest: &Path,
    manifest: &DraftManifest,
    repo_dir: &Path,
) -> Result<(), DraftFormatError> {
    if !repo_dir.is_dir() {
        return Err(invalid("missing repo directory"));
    }
    let parent = dest
        .parent()
        .ok_or_else(|| invalid("draft path has no parent"))?;
    fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(
        ".draft-write-{}-{}.tmp",
        std::process::id(),
        now_ms()
    ));
    {
        let file = File::create(&tmp)?;
        let mut zip = ZipWriter::new(file);
        let manifest_bytes = write_manifest(manifest)?;
        zip.start_file(MANIFEST_NAME, store_options())?;
        zip.write_all(&manifest_bytes)?;
        add_dir_to_zip(&mut zip, repo_dir, REPO_DIR)?;
        zip.finish()?;
    }
    sync_file(&tmp)?;
    fs::rename(&tmp, dest)?;
    sync_dir(parent)?;
    Ok(())
}

/// If `path` is missing, use a sibling `.draft.prev` from an interrupted pack (best-effort).
pub fn resolve_draft_archive(path: &Path) -> PathBuf {
    if path.is_file() {
        return path.to_path_buf();
    }
    let prev = path.with_extension("draft.prev");
    if prev.is_file() {
        return prev;
    }
    path.to_path_buf()
}

fn add_dir_to_zip<W: Write + std::io::Seek>(
    zip: &mut ZipWriter<W>,
    dir: &Path,
    prefix_in_zip: &str,
) -> Result<(), DraftFormatError> {
    for entry in walkdir_light(dir)? {
        let rel = entry.strip_prefix(dir).map_err(|_| invalid("path"))?;
        let name = if prefix_in_zip.is_empty() {
            rel.to_string_lossy().replace('\\', "/")
        } else {
            format!(
                "{}/{}",
                prefix_in_zip.trim_end_matches('/'),
                rel.to_string_lossy().replace('\\', "/")
            )
        };
        if entry.is_dir() {
            if !name.ends_with('/') {
                zip.add_directory(format!("{name}/"), store_options())?;
            }
        } else {
            zip.start_file(&name, store_options())?;
            let mut f = File::open(&entry)?;
            std::io::copy(&mut f, zip)?;
        }
    }
    Ok(())
}

fn walkdir_light(root: &Path) -> Result<Vec<PathBuf>, DraftFormatError> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            out.push(path.clone());
            if path.is_dir() {
                stack.push(path);
            }
        }
    }
    out.sort();
    Ok(out)
}

/// Unpack a `.draft` zip into `dest_dir` (creates `dest_dir/manifest.json` and `dest_dir/repo.git/`).
pub fn unpack_draft(archive: &Path, dest_dir: &Path) -> Result<DraftManifest, DraftFormatError> {
    fs::create_dir_all(dest_dir)?;
    let file = File::open(archive)?;
    let mut zip = ZipArchive::new(file)?;
    let mut manifest: Option<DraftManifest> = None;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        let name = entry.name().to_string();
        if name == MANIFEST_NAME {
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf)?;
            manifest = Some(read_manifest(&buf)?);
            let out = dest_dir.join(MANIFEST_NAME);
            fs::write(out, &buf)?;
            continue;
        }
        if name.starts_with(REPO_DIR) {
            let rel = name
                .strip_prefix(REPO_DIR)
                .unwrap_or(&name)
                .trim_start_matches('/');
            let out = dest_dir.join(REPO_DIR).join(rel);
            if name.ends_with('/') {
                fs::create_dir_all(&out)?;
            } else {
                if let Some(p) = out.parent() {
                    fs::create_dir_all(p)?;
                }
                let mut f = File::create(&out)?;
                std::io::copy(&mut entry, &mut f)?;
            }
        }
    }
    manifest.ok_or_else(|| invalid("draft missing manifest"))
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn sync_file(path: &Path) -> Result<(), DraftFormatError> {
    let f = File::open(path)?;
    f.sync_all()?;
    Ok(())
}

fn sync_dir(path: &Path) -> Result<(), DraftFormatError> {
    if cfg!(unix) {
        if let Ok(f) = File::open(path) {
            let _ = f.sync_all();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn pack_replace_never_leaves_gap_without_dest() {
        let work = tempdir().unwrap();
        let repo = work.path().join("repo.git");
        fs::create_dir_all(repo.join("objects")).unwrap();
        fs::write(repo.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        let manifest = DraftManifest {
            format: DRAFT_FORMAT.into(),
            format_version: DRAFT_FORMAT_VERSION,
            app_version: "0.1.1".into(),
            book_id: "gap".into(),
            title: "Gap".into(),
        };
        let draft = work.path().join("book.draft");
        pack_draft(&draft, &manifest, &repo).unwrap();
        assert!(draft.is_file());
        // Simulate crash after dest was removed in the old two-rename scheme: dest must still exist
        // after a successful replace-style pack.
        pack_draft(&draft, &manifest, &repo).unwrap();
        assert!(draft.is_file());
    }

    #[test]
    fn pack_unpack_round_trip() {
        let work = tempdir().unwrap();
        let repo = work.path().join("repo.git");
        fs::create_dir_all(repo.join("objects")).unwrap();
        fs::write(repo.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        let manifest = DraftManifest {
            format: DRAFT_FORMAT.into(),
            format_version: DRAFT_FORMAT_VERSION,
            app_version: "0.1.1".into(),
            book_id: "b1".into(),
            title: "Test".into(),
        };
        let draft = work.path().join("book.draft");
        pack_draft(&draft, &manifest, &repo).unwrap();
        let out = work.path().join("out");
        let m2 = unpack_draft(&draft, &out).unwrap();
        assert_eq!(m2.book_id, "b1");
        assert!(out.join("repo.git/HEAD").is_file());
    }
}
