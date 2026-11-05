//! Orchestrates draft repos, commits, and `.draft` file I/O.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri_plugin_dialog::DialogExt;

use crate::storage::Store;

use super::format::{self, DraftManifest, DRAFT_FORMAT, DRAFT_FORMAT_VERSION, REPO_DIR};
use super::repo::{CommitEntry, DraftRepo};
use super::sync;

const CHECKPOINT_DEBOUNCE_MS: u128 = 5000;

pub struct DraftService {
    store_data_dir: PathBuf,
    app_version: String,
    /// manuscript id → working repo path
    working: Mutex<HashMap<String, PathBuf>>,
    last_checkpoint: Mutex<HashMap<String, u128>>,
    /// Serialize pack, commit, open, restore (git2 + SQLite hydrate).
    op: Mutex<()>,
}

impl DraftService {
    pub fn new(data_dir: PathBuf, app_version: String) -> Self {
        Self {
            store_data_dir: data_dir,
            app_version,
            working: Mutex::new(HashMap::new()),
            last_checkpoint: Mutex::new(HashMap::new()),
            op: Mutex::new(()),
        }
    }

    fn with_op<T>(&self, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let _guard = self.op.lock().expect("draft op");
        f()
    }

    fn work_dir(&self, manuscript_id: &str) -> PathBuf {
        self.store_data_dir.join("draft-repos").join(manuscript_id)
    }

    fn hydrate_from_worktree(
        &self,
        store: &Store,
        manuscript_id: &str,
        worktree: &Path,
    ) -> Result<(), String> {
        sync::sync_worktree_to_store(store, manuscript_id, worktree).map_err(|e| e.to_string())
    }

    pub fn ensure_open(&self, store: &Store, manuscript_id: &str) -> Result<PathBuf, String> {
        self.with_op(|| self.ensure_open_inner(store, manuscript_id))
    }

    fn ensure_open_inner(&self, store: &Store, manuscript_id: &str) -> Result<PathBuf, String> {
        let mut map = self.working.lock().expect("draft working");
        if let Some(p) = map.get(manuscript_id) {
            return Ok(p.clone());
        }
        let dir = self.work_dir(manuscript_id);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut fresh_unpack = false;
        if !dir.join(".git").exists() {
            if let Some(path) = store
                .draft_file_path(manuscript_id)
                .map_err(|e| e.to_string())?
            {
                let archive = Path::new(&path);
                if archive.is_file() {
                    let unpacked = dir.join(".unpack");
                    format::unpack_draft(archive, &unpacked).map_err(|e| e.to_string())?;
                    let bare = unpacked.join(REPO_DIR);
                    copy_bare_to_working(&bare, &dir).map_err(|e| e.to_string())?;
                    DraftRepo::open_working(&dir)
                        .map_err(|e| e.to_string())?
                        .checkout_head()
                        .map_err(|e| e.to_string())?;
                    fresh_unpack = true;
                } else {
                    DraftRepo::init_working(&dir).map_err(|e| e.to_string())?;
                }
            } else {
                DraftRepo::init_working(&dir).map_err(|e| e.to_string())?;
            }
        }
        map.insert(manuscript_id.to_string(), dir.clone());
        drop(map);
        if fresh_unpack {
            self.hydrate_from_worktree(store, manuscript_id, &dir)?;
        }
        Ok(dir)
    }

    pub fn checkpoint_if_due(
        &self,
        store: &Store,
        manuscript_id: &str,
        message: &str,
    ) -> Result<Option<String>, String> {
        self.with_op(|| {
            let now = now_ms();
            let mut last = self.last_checkpoint.lock().expect("draft checkpoint");
            if let Some(prev) = last.get(manuscript_id) {
                if now.saturating_sub(*prev) < CHECKPOINT_DEBOUNCE_MS {
                    return Ok(None);
                }
            }
            let oid = self.commit_now_inner(
                store,
                manuscript_id,
                message,
                &author_name(store),
                "author@swarmdraft.local",
            )?;
            if oid.is_some() {
                last.insert(manuscript_id.to_string(), now);
            }
            Ok(oid)
        })
    }

    pub fn commit_now(
        &self,
        store: &Store,
        manuscript_id: &str,
        message: &str,
        committer_name: &str,
        committer_email: &str,
    ) -> Result<Option<String>, String> {
        self.with_op(|| {
            self.commit_now_inner(
                store,
                manuscript_id,
                message,
                committer_name,
                committer_email,
            )
        })
    }

    fn commit_now_inner(
        &self,
        store: &Store,
        manuscript_id: &str,
        message: &str,
        committer_name: &str,
        committer_email: &str,
    ) -> Result<Option<String>, String> {
        let dir = self
            .ensure_open_inner(store, manuscript_id)
            .map_err(|e| format!("ensure_open: {e}"))?;
        sync::sync_store_to_worktree(store, manuscript_id, &dir)
            .map_err(|e| format!("sync: {e}"))?;
        let repo = DraftRepo::open_working(&dir).map_err(|e| format!("open_working: {e}"))?;
        let oid = repo
            .commit_all(message, committer_name, committer_email)
            .map_err(|e| format!("commit: {e}"))?;
        if oid.is_some() {
            self.pack_if_linked_inner(store, manuscript_id)
                .map_err(|e| format!("pack: {e}"))?;
        }
        Ok(oid)
    }

    pub fn commit_review_decision(
        &self,
        store: &Store,
        manuscript_id: &str,
        accepted: bool,
        bot_name: &str,
        chapter_title: &str,
        _decided_by: &str,
    ) -> Result<Option<String>, String> {
        self.with_op(|| {
            let verb = if accepted { "Accepted" } else { "Rejected" };
            let msg = format!("{verb} {bot_name}'s change in {chapter_title}");
            // Git committer is the bot for review checkpoints (#116 slice); author remains human in SQLite.
            let oid = self.commit_now_inner(
                store,
                manuscript_id,
                &msg,
                bot_name,
                "bot@swarmdraft.local",
            )?;
            if accepted {
                if let Some(branch) = bot_branch_name(bot_name) {
                    let dir = self.ensure_open_inner(store, manuscript_id)?;
                    let repo = DraftRepo::open_working(&dir).map_err(|e| e.to_string())?;
                    if repo.ensure_bot_branch(&branch).is_ok() {
                        let _ = repo.merge_bot_branch(&branch, &author_name(store));
                    }
                }
            }
            Ok(oid)
        })
    }

    pub fn pack_if_linked(&self, store: &Store, manuscript_id: &str) -> Result<(), String> {
        self.with_op(|| self.pack_if_linked_inner(store, manuscript_id))
    }

    fn pack_if_linked_inner(&self, store: &Store, manuscript_id: &str) -> Result<(), String> {
        let Some(draft_path) = store
            .draft_file_path(manuscript_id)
            .map_err(|e| e.to_string())?
        else {
            return Ok(());
        };
        let dir = self.ensure_open_inner(store, manuscript_id)?;
        let manuscript = store
            .get_manuscript(manuscript_id)
            .map_err(|e| e.to_string())?;
        let bare = dir.join(".bare-export");
        let repo = DraftRepo::open_working(&dir).map_err(|e| e.to_string())?;
        repo.export_bare(&bare).map_err(|e| e.to_string())?;
        let manifest = DraftManifest {
            format: DRAFT_FORMAT.into(),
            format_version: DRAFT_FORMAT_VERSION,
            app_version: self.app_version.clone(),
            book_id: manuscript_id.to_string(),
            title: manuscript.title,
        };
        if let Some(parent) = Path::new(&draft_path).parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        format::pack_draft(Path::new(&draft_path), &manifest, &bare).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn save_as_dialog(
        &self,
        app: &tauri::AppHandle,
        store: &Store,
        manuscript_id: &str,
    ) -> Result<Option<String>, String> {
        self.with_op(|| {
            let manuscript = store
                .get_manuscript(manuscript_id)
                .map_err(|e| e.to_string())?;
            let default_name = sanitize_filename(&manuscript.title);
            let picked = app
                .dialog()
                .file()
                .set_file_name(format!("{default_name}.draft"))
                .add_filter("swarmDraft draft", &["draft"])
                .blocking_save_file();
            let Some(file) = picked else {
                return Ok(None);
            };
            let path = file.to_string();
            store
                .set_draft_file_path(manuscript_id, &path)
                .map_err(|e| e.to_string())?;
            self.pack_if_linked_inner(store, manuscript_id)?;
            Ok(Some(path))
        })
    }

    pub fn open_dialog(
        &self,
        app: &tauri::AppHandle,
        store: &Store,
    ) -> Result<Option<String>, String> {
        let picked = app
            .dialog()
            .file()
            .add_filter("swarmDraft draft", &["draft"])
            .blocking_pick_file();
        let Some(file) = picked else {
            return Ok(None);
        };
        let path = file.to_string();
        self.open_draft_path(store, &path)
    }

    pub fn open_draft_path(&self, store: &Store, path: &str) -> Result<Option<String>, String> {
        self.with_op(|| self.open_draft_path_inner(store, path))
    }

    fn open_draft_path_inner(&self, store: &Store, path: &str) -> Result<Option<String>, String> {
        let unpacked = tempfile::tempdir().map_err(|e| e.to_string())?;
        let manifest =
            format::unpack_draft(Path::new(path), unpacked.path()).map_err(|e| e.to_string())?;
        let id = if let Some(existing) = store
            .manuscript_id_for_draft_path(path)
            .map_err(|e| e.to_string())?
        {
            existing
        } else {
            manifest.book_id.clone()
        };
        if store.get_manuscript(&id).is_err() {
            store
                .create_manuscript_with_id(&id, &manifest.title)
                .map_err(|e| e.to_string())?;
        }
        store
            .set_draft_file_path(&id, path)
            .map_err(|e| e.to_string())?;
        let work = self.work_dir(&id);
        if work.exists() {
            std::fs::remove_dir_all(&work).map_err(|e| e.to_string())?;
        }
        std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
        let bare = unpacked.path().join(REPO_DIR);
        copy_bare_to_working(&bare, &work).map_err(|e| e.to_string())?;
        DraftRepo::open_working(&work)
            .map_err(|e| e.to_string())?
            .checkout_head()
            .map_err(|e| e.to_string())?;
        self.hydrate_from_worktree(store, &id, &work)?;
        self.working
            .lock()
            .expect("draft working")
            .insert(id.clone(), work);
        Ok(Some(id))
    }

    pub fn history(
        &self,
        store: &Store,
        manuscript_id: &str,
        limit: usize,
        skip: usize,
    ) -> Result<Vec<CommitEntry>, String> {
        self.with_op(|| {
            let dir = self.ensure_open_inner(store, manuscript_id)?;
            DraftRepo::open_working(&dir)
                .map_err(|e| e.to_string())?
                .list_main_commits(limit, skip)
                .map_err(|e| e.to_string())
        })
    }

    pub fn restore(
        &self,
        store: &Store,
        manuscript_id: &str,
        oid: &str,
        committer_name: &str,
    ) -> Result<String, String> {
        self.with_op(|| {
            let dir = self.ensure_open_inner(store, manuscript_id)?;
            let repo = DraftRepo::open_working(&dir).map_err(|e| e.to_string())?;
            let time = repo
                .list_main_commits(1, 0)
                .ok()
                .and_then(|v| v.first().map(|c| c.time_unix))
                .unwrap_or(0);
            let msg = format!("Restored version from {time}");
            let new_oid = repo
                .restore_as_new_commit(oid, committer_name, "author@swarmdraft.local", &msg)
                .map_err(|e| e.to_string())?;
            self.hydrate_from_worktree(store, manuscript_id, &dir)?;
            self.pack_if_linked_inner(store, manuscript_id)?;
            Ok(new_oid)
        })
    }
}

fn copy_bare_to_working(bare: &Path, work: &Path) -> Result<(), std::io::Error> {
    std::fs::create_dir_all(work)?;
    copy_dir(bare, &work.join(".git"))?;
    Ok(())
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), std::io::Error> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let dest = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &dest)?;
        } else {
            std::fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

fn author_name(store: &Store) -> String {
    store
        .user_display_name()
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Author".to_string())
}

fn bot_branch_name(bot_name: &str) -> Option<String> {
    let slug: String = bot_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    if slug.is_empty() {
        None
    } else {
        Some(format!("bot/{slug}/session"))
    }
}

fn sanitize_filename(title: &str) -> String {
    let mut s: String = title
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == ' ' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.is_empty() {
        "Untitled draft".into()
    } else {
        s
    }
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}
