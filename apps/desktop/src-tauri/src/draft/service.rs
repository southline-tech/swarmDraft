//! Orchestrates draft repos, commits, and `.draft` file I/O.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};

use chrono::{Local, TimeZone};
use serde::Serialize;
use tauri::Window;
use tauri_plugin_dialog::DialogExt;

use crate::manuscripts::{Comment, ReviewDecisionRecord};
use crate::storage::Store;

use super::changes::{self, DraftChangeResolve};
use super::format::{self, DraftManifest, DRAFT_FORMAT, DRAFT_FORMAT_VERSION, REPO_DIR};
use super::repo::{append_trailers, message_trailers, CommitEntry, CommitOptions, DraftRepo};
use super::sessions::{self, SessionRecord};
use super::sync;

const CHECKPOINT_DEBOUNCE_MS: u128 = 5000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftRecoveryOffer {
    pub manuscript_id: String,
    pub draft_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDraftResult {
    pub manuscript_id: String,
    pub recovery: Option<DraftRecoveryOffer>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum DraftSaveOutcome {
    Committed { oid: Option<String> },
    NeedsSaveAs,
}

struct BotSession {
    branch: String,
}

type ResolveCache = HashMap<String, (String, HashMap<String, DraftChangeResolve>)>;

pub struct DraftService {
    store_data_dir: PathBuf,
    app_version: String,
    /// manuscript id → working repo path
    working: Mutex<HashMap<String, PathBuf>>,
    last_checkpoint: Mutex<HashMap<String, u128>>,
    /// (manuscript id, bot id) → active bot branch session
    bot_sessions: Mutex<HashMap<(String, String), BotSession>>,
    /// Active human editing session for an open manuscript. The git ref is kept after it ends.
    human_sessions: Mutex<HashMap<String, SessionRecord>>,
    /// Missing entry means a human commit may start a session. `false` after the session ends.
    autostart: Mutex<HashMap<String, bool>>,
    /// Change lookups cached until a main, bot, or session tip moves.
    resolve_cache: Mutex<ResolveCache>,
    /// Serialize pack, commit, open, restore (git2 + SQLite hydrate).
    op: Mutex<()>,
    /// Comment commits queued off the caller. Restore and open wait until this is zero
    /// so a rebuild cannot drop a reply that has not landed in git yet.
    main_commit_pending: Mutex<usize>,
    main_commit_cv: Condvar,
    /// Bot comments and document updates saved in SQLite and not yet on a `bot/*` commit.
    /// Reconcile keeps them, and the bot commit writes these bytes rather than the rebuilt cache.
    bot_writes: Mutex<BotWrites>,
    /// Test hook invoked once after restore or open has the op lock and before it rebuilds the cache.
    #[cfg(test)]
    op_entered: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

/// A bot comment or suggestion saved by `agent_write`, retained until its git commit lands.
#[derive(Clone)]
pub struct BotRetention {
    pub comment: Option<Comment>,
    pub doc_id: Option<String>,
    pub doc_update: Option<Vec<u8>>,
}

struct BotWrites {
    next_token: u64,
    pending: Vec<PendingBotWrite>,
}

#[derive(Clone)]
struct PendingBotWrite {
    token: u64,
    manuscript_id: String,
    comment: Option<Comment>,
    doc_id: Option<String>,
    doc_update: Option<Vec<u8>>,
    /// Suggestion ids this update added. Filled when a checkpoint can see them, and
    /// still left out of `review/changes.json` after open squashes the update log.
    change_ids: Vec<String>,
}

impl DraftService {
    pub fn new(data_dir: PathBuf, app_version: String) -> Self {
        Self {
            store_data_dir: data_dir,
            app_version,
            working: Mutex::new(HashMap::new()),
            last_checkpoint: Mutex::new(HashMap::new()),
            bot_sessions: Mutex::new(HashMap::new()),
            human_sessions: Mutex::new(HashMap::new()),
            autostart: Mutex::new(HashMap::new()),
            resolve_cache: Mutex::new(HashMap::new()),
            op: Mutex::new(()),
            main_commit_pending: Mutex::new(0),
            main_commit_cv: Condvar::new(),
            bot_writes: Mutex::new(BotWrites {
                next_token: 1,
                pending: Vec::new(),
            }),
            #[cfg(test)]
            op_entered: Mutex::new(None),
        }
    }

    /// Run `write` and remember its comment and document update until the bot commit lands.
    /// Does not take the draft op lock: a bot HTTP call still returns while that lock is held.
    /// The sqlite write and the retain share this lock with reconcile, so a rebuild cannot
    /// drop the row in the gap between them.
    pub fn record_bot_write<T, E>(
        &self,
        manuscript_id: &str,
        retention: BotRetention,
        write: impl FnOnce() -> Result<T, E>,
    ) -> Result<T, E> {
        let mut guard = self.bot_writes.lock().expect("bot writes");
        let result = write()?;
        let doc_update = retention.doc_update.filter(|update| update.len() > 2);
        if retention.comment.is_some() || doc_update.is_some() {
            let token = guard.next_token;
            guard.next_token += 1;
            guard.pending.push(PendingBotWrite {
                token,
                manuscript_id: manuscript_id.to_string(),
                comment: retention.comment,
                doc_id: retention.doc_id,
                doc_update,
                change_ids: Vec::new(),
            });
        }
        Ok(result)
    }

    fn begin_main_commit(&self) {
        let mut n = self.main_commit_pending.lock().expect("main commits");
        *n += 1;
    }

    fn finish_main_commit(&self) {
        let mut n = self.main_commit_pending.lock().expect("main commits");
        *n = n.saturating_sub(1);
        self.main_commit_cv.notify_all();
    }

    fn main_commits_pending(&self) -> bool {
        *self.main_commit_pending.lock().expect("main commits") > 0
    }

    fn wait_for_main_commits(&self) {
        let mut n = self.main_commit_pending.lock().expect("main commits");
        while *n > 0 {
            n = self.main_commit_cv.wait(n).expect("main commits");
        }
    }

    /// Run `f` under the op lock only after queued comment commits have finished.
    /// A commit that arrives while `f` is waiting is included. `f` must not take the op lock.
    fn with_op_after_queued_commits<T>(
        &self,
        f: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        loop {
            self.wait_for_main_commits();
            let _guard = self.op.lock().expect("draft op");
            if self.main_commits_pending() {
                continue;
            }
            #[cfg(test)]
            self.fire_op_entered();
            return f();
        }
    }

    #[cfg(test)]
    fn fire_op_entered(&self) {
        let hook = self.op_entered.lock().expect("op entered").take();
        if let Some(hook) = hook {
            hook();
        }
    }

    pub fn worktree_path(&self, manuscript_id: &str) -> PathBuf {
        self.work_dir(manuscript_id)
    }

    fn with_op<T>(&self, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let _guard = self.op.lock().expect("draft op");
        f()
    }

    /// Hold the draft op lock for the duration of `f`.
    /// Path pickers and bot HTTP handlers must not wait on this across UI or the request.
    pub fn with_op_guard<T>(&self, f: impl FnOnce() -> T) -> T {
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
        // Held across the rebuild and the reapply. A bot write either lands before the
        // deletes, and is put back, or waits and lands after them.
        let guard = self.bot_writes.lock().expect("bot writes");
        sync::sync_worktree_to_store(store, manuscript_id, worktree).map_err(|e| e.to_string())?;
        let pending: Vec<PendingBotWrite> = guard
            .pending
            .iter()
            .filter(|write| write.manuscript_id == manuscript_id)
            .cloned()
            .collect();
        apply_pending_bot_writes(store, manuscript_id, &pending).map(|_| ())
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
        immediate: bool,
    ) -> Result<Option<String>, String> {
        self.with_op(|| {
            let now = now_ms();
            let mut last = self.last_checkpoint.lock().expect("draft checkpoint");
            if !immediate {
                if let Some(prev) = last.get(manuscript_id) {
                    if now.saturating_sub(*prev) < CHECKPOINT_DEBOUNCE_MS {
                        return Ok(None);
                    }
                }
            }
            let oid = self.commit_now_inner(
                store,
                manuscript_id,
                message,
                &author_name(store),
                "author@swarmdraft.local",
                false,
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
                false,
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
        allow_empty: bool,
    ) -> Result<Option<String>, String> {
        let dir = self
            .ensure_open_inner(store, manuscript_id)
            .map_err(|e| format!("ensure_open: {e}"))?;
        let session = self.session_for_commit(store, manuscript_id)?;
        // Held across the read of pending bot writes and the file sync. A bot write
        // waits, then lands in SQLite after this checkpoint's files are already written.
        self.sync_main_worktree(store, manuscript_id, &dir)?;
        if let Some(record) = &session {
            sessions::write_session_file(&dir, record).map_err(|e| format!("session: {e}"))?;
        }
        let message = message_with_session(message, session.as_ref().map(|s| s.id.as_str()));
        let repo = DraftRepo::open_working(&dir).map_err(|e| format!("open_working: {e}"))?;
        let options = CommitOptions {
            allow_empty,
            advance_branch: session.as_ref().map(|s| format!("session/{}", s.id)),
        };
        let oid = repo
            .commit_all(&message, committer_name, committer_email, &options)
            .map_err(|e| format!("commit: {e}"))?;
        if oid.is_some() {
            self.pack_if_linked_inner(store, manuscript_id)
                .map_err(|e| format!("pack: {e}"))?;
        }
        Ok(oid)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn commit_review_decision(
        &self,
        store: &Store,
        manuscript_id: &str,
        accepted: bool,
        bot_name: &str,
        chapter_title: &str,
        decided_by: &str,
        bot_agent_id: Option<&str>,
        change_id: Option<&str>,
        change_kind: Option<&str>,
        change_section_id: Option<&str>,
    ) -> Result<Option<String>, String> {
        self.with_op(|| {
            let verb = if accepted { "Accepted" } else { "Rejected" };
            let base = format!("{verb} {bot_name}'s change in {chapter_title}");
            let decision = if accepted { "accepted" } else { "rejected" };
            self.persist_review_decision(
                store,
                manuscript_id,
                decision,
                decided_by,
                change_id,
                change_kind,
                change_section_id,
            )?;
            // One suggestion reject records that id only. The bot branch ends when every
            // change that bot introduced has been rejected, so a later accept can still merge.
            if !accepted {
                if let Some(branch) = self.active_bot_branch(manuscript_id, bot_agent_id, bot_name)
                {
                    if self.bot_branch_fully_rejected(
                        store,
                        manuscript_id,
                        &branch,
                        bot_agent_id,
                    )? {
                        self.resolve_bot_originated_comments(
                            store,
                            manuscript_id,
                            &branch,
                            bot_agent_id,
                        )?;
                        self.end_bot_session(manuscript_id, bot_agent_id, bot_name);
                    }
                }
            }
            let msg = match (change_id, change_kind, change_section_id) {
                (Some(id), kind, Some(section)) if !id.is_empty() && !section.is_empty() => {
                    let mut trailers = vec![("Change-Id", id), ("Decision", decision)];
                    if let Some(kind) = kind.filter(|k| !k.is_empty()) {
                        trailers.push(("Kind", kind));
                    }
                    trailers.push(("Section", section));
                    if !decided_by.is_empty() {
                        trailers.push(("Decided-By", decided_by));
                    }
                    append_trailers(&base, &trailers)
                }
                _ => base,
            };
            let bot_email = bot_agent_id
                .map(bot_committer_email)
                .unwrap_or_else(|| "bot@swarmdraft.local".into());
            let oid =
                self.commit_now_inner(store, manuscript_id, &msg, bot_name, &bot_email, true)?;
            if accepted {
                if let Some(branch) = self.active_bot_branch(manuscript_id, bot_agent_id, bot_name)
                {
                    let dir = self.ensure_open_inner(store, manuscript_id)?;
                    let repo = DraftRepo::open_working(&dir).map_err(|e| e.to_string())?;
                    let advance = self
                        .active_record(manuscript_id)
                        .map(|s| format!("session/{}", s.id));
                    repo.merge_bot_branch(&branch, &author_name(store), advance.as_deref())
                        .map_err(|e| format!("Couldn't merge bot changes: {e}"))?;
                    self.end_bot_session(manuscript_id, bot_agent_id, bot_name);
                    // commit_now_inner packed the accept commit, before this merge.
                    // The merge keeps that tree, so pack the commit that still
                    // has the accepted chapter and omits a path the writer removed.
                    self.pack_if_linked_inner(store, manuscript_id)?;
                }
            }
            Ok(oid)
        })
    }

    /// Start or reuse `bot/{bot}/{session}` from main and commit bot-side suggestions on it.
    /// Pending bot writes are put back into the cache first, so the commit records the row
    /// from the write after a rebuild has replaced the cache.
    pub fn commit_bot_suggestion(
        &self,
        store: &Store,
        manuscript_id: &str,
        bot_agent_id: &str,
        bot_display_name: &str,
        message: &str,
    ) -> Result<Option<String>, String> {
        self.with_op(|| {
            let branch = self.ensure_bot_session_inner(store, manuscript_id, bot_agent_id)?;
            let dir = self.ensure_open_inner(store, manuscript_id)?;
            let tokens = self.reapply_pending_bot_writes(store, manuscript_id)?;
            let repo = DraftRepo::open_working(&dir).map_err(|e| e.to_string())?;
            repo.checkout_branch(&branch)
                .map_err(|e| format!("checkout bot branch: {e}"))?;
            // This commit is what publishes the pending rows. A main checkpoint omits them.
            let _published = sync::sync_store_to_worktree(
                store,
                manuscript_id,
                &dir,
                &sync::SyncOmit::default(),
            )
            .map_err(|e| format!("sync: {e}"))?;
            let email = bot_committer_email(bot_agent_id);
            let oid = repo
                .commit_all(message, bot_display_name, &email, &CommitOptions::default())
                .map_err(|e| format!("commit: {e}"))?;
            repo.checkout_main()
                .map_err(|e| format!("checkout main: {e}"))?;
            if let Some(record) = self.active_record(manuscript_id) {
                if let Err(e) = sessions::write_session_file(&dir, &record) {
                    eprintln!("draft session file not rewritten after bot commit: {e}");
                }
            }
            if oid.is_some() {
                self.clear_pending_bot_writes(&tokens);
                self.pack_if_linked_inner(store, manuscript_id)?;
            }
            Ok(oid)
        })
    }

    /// Put this book's saved bot writes back into SQLite. Returns their tokens so a
    /// successful commit can drop them.
    fn reapply_pending_bot_writes(
        &self,
        store: &Store,
        manuscript_id: &str,
    ) -> Result<Vec<u64>, String> {
        let guard = self.bot_writes.lock().expect("bot writes");
        let pending: Vec<PendingBotWrite> = guard
            .pending
            .iter()
            .filter(|write| write.manuscript_id == manuscript_id)
            .cloned()
            .collect();
        apply_pending_bot_writes(store, manuscript_id, &pending)
    }

    fn clear_pending_bot_writes(&self, tokens: &[u64]) {
        if tokens.is_empty() {
            return;
        }
        let mut guard = self.bot_writes.lock().expect("bot writes");
        guard.pending.retain(|write| !tokens.contains(&write.token));
    }

    /// Write the cache for a `main` commit, skipping bot comments and suggestions whose
    /// `bot/*` commit has not landed. The lock covers the skip set and the sync, so a bot
    /// write cannot enter SQLite in between and get published onto `main`. A keystroke
    /// that does not apply without one of those suggestions stays in the chapter. The
    /// suggestion id stays out of `review/changes.json`.
    fn sync_main_worktree(
        &self,
        store: &Store,
        manuscript_id: &str,
        dir: &Path,
    ) -> Result<(), String> {
        let mut guard = self.bot_writes.lock().expect("bot writes");
        let mut omit = sync::SyncOmit::default();
        for write in guard
            .pending
            .iter()
            .filter(|write| write.manuscript_id == manuscript_id)
        {
            if let Some(comment) = &write.comment {
                omit.comment_ids.insert(comment.id.clone());
            }
            if let (Some(doc_id), Some(update)) = (&write.doc_id, &write.doc_update) {
                if update.len() > 2 {
                    omit.doc_updates
                        .entry(doc_id.clone())
                        .or_default()
                        .push(update.clone());
                }
            }
            omit.change_ids.extend(write.change_ids.iter().cloned());
        }
        let discovered = sync::sync_store_to_worktree(store, manuscript_id, dir, &omit)
            .map_err(|e| format!("sync: {e}"))?;
        for write in guard
            .pending
            .iter_mut()
            .filter(|write| write.manuscript_id == manuscript_id)
        {
            if let Some(doc_id) = &write.doc_id {
                if let Some(ids) = discovered.get(doc_id) {
                    if !ids.is_empty() {
                        write.change_ids = ids.iter().cloned().collect();
                    }
                }
            }
        }
        Ok(())
    }

    pub fn bot_branch_exists(
        &self,
        store: &Store,
        manuscript_id: &str,
        bot_agent_id: &str,
        bot_name: &str,
    ) -> Result<bool, String> {
        self.with_op(|| {
            let branch = self
                .active_bot_branch(manuscript_id, Some(bot_agent_id), bot_name)
                .ok_or_else(|| "no bot session".to_string())?;
            let dir = self.ensure_open_inner(store, manuscript_id)?;
            let repo = DraftRepo::open_working(&dir).map_err(|e| e.to_string())?;
            Ok(repo.has_branch(&branch))
        })
    }

    pub fn save_linked_or_needs_as(
        &self,
        store: &Store,
        manuscript_id: &str,
        message: &str,
    ) -> Result<DraftSaveOutcome, String> {
        self.with_op(|| {
            if store
                .draft_file_path(manuscript_id)
                .map_err(|e| e.to_string())?
                .is_none()
            {
                return Ok(DraftSaveOutcome::NeedsSaveAs);
            }
            let oid = self.commit_now_inner(
                store,
                manuscript_id,
                message,
                &author_name(store),
                "author@swarmdraft.local",
                false,
            )?;
            Ok(DraftSaveOutcome::Committed { oid })
        })
    }

    pub fn after_word_import(
        &self,
        store: &Store,
        manuscript_id: &str,
        source_file_name: &str,
    ) -> Result<String, String> {
        self.with_op(|| {
            let _manuscript = store
                .get_manuscript(manuscript_id)
                .map_err(|e| e.to_string())?;
            let drafts_dir = self.store_data_dir.join("drafts");
            std::fs::create_dir_all(&drafts_dir).map_err(|e| e.to_string())?;
            let base = sanitize_filename(source_file_name.trim_end_matches(".docx"));
            let path = unique_draft_path(&drafts_dir, &base);
            store
                .set_draft_file_path(manuscript_id, &path.to_string_lossy())
                .map_err(|e| e.to_string())?;
            let label = Path::new(source_file_name)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(source_file_name);
            self.commit_now_inner(
                store,
                manuscript_id,
                &format!("Imported {label}"),
                &author_name(store),
                "author@swarmdraft.local",
                false,
            )?;
            Ok(path.to_string_lossy().into_owned())
        })
    }

    pub fn pack_recovery_if_newer(&self, store: &Store, manuscript_id: &str) -> Result<(), String> {
        self.with_op(|| {
            self.pack_if_linked_inner(store, manuscript_id)?;
            Ok(())
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
        // Outside the worktree so the export is not committed on the next save.
        let bare = tempfile::tempdir().map_err(|e| e.to_string())?;
        let repo = DraftRepo::open_working(&dir).map_err(|e| e.to_string())?;
        repo.export_bare(bare.path()).map_err(|e| e.to_string())?;
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
        format::pack_draft(Path::new(&draft_path), &manifest, bare.path())
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Native Save As. The file picker runs **outside** the draft op lock so checkpoint
    /// and bot commits are not stuck behind the dialog. Cancel returns `Ok(None)`.
    pub fn save_as_dialog(
        &self,
        app: &tauri::AppHandle,
        window: &Window,
        store: &Store,
        manuscript_id: &str,
    ) -> Result<Option<String>, String> {
        let manuscript = store
            .get_manuscript(manuscript_id)
            .map_err(|e| e.to_string())?;
        let default_name = sanitize_filename(&manuscript.title);
        self.save_as_with_picker(store, manuscript_id, || {
            let mut dialog = app
                .dialog()
                .file()
                .set_parent(window)
                .set_title("Save As")
                .set_file_name(format!("{default_name}.draft"))
                .add_filter("swarmDraft draft", &["draft"]);
            if let Some(dir) = crate::save_copy::documents_dir(app) {
                dialog = dialog.set_directory(dir);
            }
            dialog.blocking_save_file().map(|file| file.to_string())
        })
    }

    /// Run `pick` with the op lock free, then link + commit + pack only if a path was chosen.
    /// `pick` returning `None` is cancel and does not take the lock.
    pub fn save_as_with_picker<F>(
        &self,
        store: &Store,
        manuscript_id: &str,
        pick: F,
    ) -> Result<Option<String>, String>
    where
        F: FnOnce() -> Option<String>,
    {
        let Some(raw) = pick() else {
            return Ok(None);
        };
        let path = path_with_draft_extension(&raw);
        self.finish_save_as(store, manuscript_id, &path).map(Some)
    }

    /// Link `path` as the draft file, commit, and pack. Holds the op lock only for that work.
    pub fn finish_save_as(
        &self,
        store: &Store,
        manuscript_id: &str,
        path: &str,
    ) -> Result<String, String> {
        self.with_op(|| self.finish_save_as_inner(store, manuscript_id, path))
    }

    fn finish_save_as_inner(
        &self,
        store: &Store,
        manuscript_id: &str,
        path: &str,
    ) -> Result<String, String> {
        store
            .set_draft_file_path(manuscript_id, path)
            .map_err(|e| e.to_string())?;
        self.commit_now_inner(
            store,
            manuscript_id,
            "Saved",
            &author_name(store),
            "author@swarmdraft.local",
            false,
        )?;
        self.pack_if_linked_inner(store, manuscript_id)?;
        Ok(path.to_string())
    }

    pub fn open_dialog(
        &self,
        app: &tauri::AppHandle,
        store: &Store,
        force_discard_recovery: bool,
    ) -> Result<Option<OpenDraftResult>, String> {
        let picked = app
            .dialog()
            .file()
            .add_filter("swarmDraft draft", &["draft"])
            .blocking_pick_file();
        let Some(file) = picked else {
            return Ok(None);
        };
        let path = file.to_string();
        self.open_draft_path(store, &path, force_discard_recovery)
    }

    pub fn open_draft_path(
        &self,
        store: &Store,
        path: &str,
        force_discard_recovery: bool,
    ) -> Result<Option<OpenDraftResult>, String> {
        self.with_op_after_queued_commits(|| {
            self.open_draft_path_inner(store, path, force_discard_recovery)
        })
    }

    fn open_draft_path_inner(
        &self,
        store: &Store,
        path: &str,
        force_discard_recovery: bool,
    ) -> Result<Option<OpenDraftResult>, String> {
        let archive_path = format::resolve_draft_archive(Path::new(path));
        if !archive_path.is_file() {
            return Err("That file isn't a swarmDraft draft.".into());
        }
        let file_head = head_oid_from_archive(&archive_path)?;
        let id_preview = if let Some(existing) = store
            .manuscript_id_for_draft_path(path)
            .map_err(|e| e.to_string())?
        {
            existing
        } else {
            let unpacked = tempfile::tempdir().map_err(|e| e.to_string())?;
            let manifest =
                format::unpack_draft(&archive_path, unpacked.path()).map_err(|e| e.to_string())?;
            manifest.book_id
        };
        let work = self.work_dir(&id_preview);
        if !force_discard_recovery {
            if let Some(recovery) =
                recovery_offer_if_worktree_newer(&work, path, &id_preview, &file_head)?
            {
                return Ok(Some(OpenDraftResult {
                    manuscript_id: id_preview,
                    recovery: Some(recovery),
                }));
            }
        }
        let unpacked = tempfile::tempdir().map_err(|e| e.to_string())?;
        let manifest =
            format::unpack_draft(&archive_path, unpacked.path()).map_err(|e| e.to_string())?;
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
        if let Err(e) = self.begin_editing_session_inner(store, &id) {
            eprintln!("draft session start failed: {e}");
        }
        Ok(Some(OpenDraftResult {
            manuscript_id: id,
            recovery: None,
        }))
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
        self.with_op_after_queued_commits(|| {
            let dir = self.ensure_open_inner(store, manuscript_id)?;
            let repo = DraftRepo::open_working(&dir).map_err(|e| e.to_string())?;
            let time = repo.commit_time_unix(oid).unwrap_or(0);
            let session = self.session_for_commit(store, manuscript_id)?;
            let msg = message_with_session(
                &format!("Restored version from {}", format_when_human(time)),
                session.as_ref().map(|s| s.id.as_str()),
            );
            let advance = session.as_ref().map(|s| format!("session/{}", s.id));
            let new_oid = repo
                .restore_as_new_commit(
                    oid,
                    committer_name,
                    "author@swarmdraft.local",
                    &msg,
                    advance.as_deref(),
                )
                .map_err(|e| e.to_string())?;
            self.hydrate_from_worktree(store, manuscript_id, &dir)?;
            if let Some(record) = self.active_record(manuscript_id) {
                if let Err(e) = sessions::write_session_file(&dir, &record) {
                    eprintln!("draft session file not rewritten after restore: {e}");
                }
            }
            self.pack_if_linked_inner(store, manuscript_id)?;
            Ok(new_oid)
        })
    }

    /// Start `session/<id>` at the current main tip. A second call while one is active reuses it.
    pub fn begin_editing_session(
        &self,
        store: &Store,
        manuscript_id: &str,
    ) -> Result<String, String> {
        self.with_op(|| self.begin_editing_session_inner(store, manuscript_id))
    }

    /// Set `endedAt` and keep the session ref. Further commits do not start another session
    /// until [`Self::begin_editing_session`].
    pub fn end_editing_session(&self, store: &Store, manuscript_id: &str) -> Result<(), String> {
        self.with_op(|| self.end_editing_session_inner(store, manuscript_id))
    }

    /// Drop the in-memory session without a commit. Used when storage was replaced and
    /// writing the ended record would change the restored book.
    pub fn abandon_editing_session(&self, manuscript_id: &str) -> Result<(), String> {
        self.with_op(|| {
            self.human_sessions
                .lock()
                .expect("sessions")
                .remove(manuscript_id);
            self.autostart
                .lock()
                .expect("autostart")
                .insert(manuscript_id.to_string(), false);
            Ok(())
        })
    }

    pub fn resolve_change(
        &self,
        store: &Store,
        manuscript_id: &str,
        change_id: &str,
    ) -> Result<DraftChangeResolve, String> {
        let change_id = change_id.trim();
        if change_id.is_empty() {
            return Ok(DraftChangeResolve::NotFound {
                change_id: change_id.to_string(),
            });
        }
        let change_id = change_id.to_string();
        // Cache check stays under the op lock. The history walk does not: a miss
        // can scan every commit, and Save must not wait on that.
        let prep = self.with_op(|| {
            let dir = self.ensure_open_inner(store, manuscript_id)?;
            let repo = DraftRepo::open_working(&dir).map_err(|e| e.to_string())?;
            let key = changes::tip_cache_key(&repo).map_err(|e| e.to_string())?;
            if key.is_empty() {
                return Ok(ResolvePrep::Cached(DraftChangeResolve::NotFound {
                    change_id: change_id.clone(),
                }));
            }
            let cache = self.resolve_cache.lock().expect("resolve cache");
            if let Some((cached_key, found)) = cache.get(manuscript_id) {
                if cached_key == &key {
                    let hit = found.get(&change_id).cloned().unwrap_or_else(|| {
                        DraftChangeResolve::NotFound {
                            change_id: change_id.clone(),
                        }
                    });
                    return Ok(ResolvePrep::Cached(hit));
                }
            }
            Ok(ResolvePrep::Walk { dir, key })
        })?;
        match prep {
            ResolvePrep::Cached(hit) => Ok(hit),
            ResolvePrep::Walk { dir, key } => {
                let repo = DraftRepo::open_working(&dir).map_err(|e| e.to_string())?;
                let found = changes::resolve_all(&repo).map_err(|e| e.to_string())?;
                let result = found.get(&change_id).cloned().unwrap_or_else(|| {
                    DraftChangeResolve::NotFound {
                        change_id: change_id.clone(),
                    }
                });
                self.resolve_cache
                    .lock()
                    .expect("resolve cache")
                    .insert(manuscript_id.to_string(), (key, found));
                Ok(result)
            }
        }
    }
}

enum ResolvePrep {
    Cached(DraftChangeResolve),
    Walk { dir: PathBuf, key: String },
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

fn bot_slug(bot_id: &str) -> String {
    let slug: String = bot_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    if slug.is_empty() {
        "bot".into()
    } else {
        slug
    }
}

fn bot_branch_name(bot_id: &str, session_id: &str) -> String {
    format!("bot/{}/{}", bot_slug(bot_id), session_id)
}

fn bot_committer_email(bot_id: &str) -> String {
    format!("bot-{}@swarmdraft.local", bot_slug(bot_id))
}

fn change_authored_by_bot(entry: &changes::ChangeEntry, bot_agent_id: Option<&str>) -> bool {
    if entry.author_kind != "agent" {
        return false;
    }
    match bot_agent_id {
        Some(id) if !id.is_empty() => entry.author_id == id,
        _ => true,
    }
}

fn comment_authored_by_bot(
    comment: &crate::manuscripts::Comment,
    bot_agent_id: Option<&str>,
) -> bool {
    if comment.author.kind != "agent" {
        return false;
    }
    match bot_agent_id {
        Some(id) if !id.is_empty() => comment.author.id == id,
        _ => true,
    }
}

fn new_bot_session_id() -> String {
    format!("s{}", crate::manuscripts::new_id())
}

fn message_with_session(message: &str, session_id: Option<&str>) -> String {
    let Some(id) = session_id else {
        return message.to_string();
    };
    if message_trailers(message)
        .iter()
        .any(|(key, _)| key == "Session")
    {
        return message.to_string();
    }
    append_trailers(message, &[("Session", id)])
}

impl DraftService {
    #[allow(clippy::too_many_arguments)]
    fn persist_review_decision(
        &self,
        store: &Store,
        manuscript_id: &str,
        decision: &str,
        decided_by: &str,
        change_id: Option<&str>,
        change_kind: Option<&str>,
        change_section_id: Option<&str>,
    ) -> Result<(), String> {
        let (Some(id), Some(kind), Some(section)) = (change_id, change_kind, change_section_id)
        else {
            return Ok(());
        };
        if id.is_empty() || kind.is_empty() || section.is_empty() {
            return Ok(());
        }
        let decided_by = if decided_by.is_empty() {
            "author"
        } else {
            decided_by
        };
        let decided_at = store.now().map_err(|e| e.to_string())?;
        match store.ensure_review_decision(
            manuscript_id,
            section,
            &ReviewDecisionRecord {
                kind: super::changes::map_kind(kind).into(),
                id: id.to_string(),
                status: decision.to_string(),
                decided_at,
                decided_by: decided_by.to_string(),
            },
        ) {
            Ok(()) => Ok(()),
            // A trailer-only decision (no real section row) still commits. The message keeps the kind.
            Err(crate::storage::StorageError::NotFound(_)) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    /// True when `branch` introduced at least one of this bot's changes and every one of
    /// those ids is rejected. Compared with the merge base, so a later checkpoint on `main`
    /// does not hide them. A writer suggestion that was only in the cache does not count.
    fn bot_branch_fully_rejected(
        &self,
        store: &Store,
        manuscript_id: &str,
        branch: &str,
        bot_agent_id: Option<&str>,
    ) -> Result<bool, String> {
        let introduced =
            self.changes_introduced_on_branch(store, manuscript_id, branch, bot_agent_id)?;
        if introduced.is_empty() {
            return Ok(false);
        }
        let decisions = store
            .review_decisions_for_manuscript(manuscript_id)
            .map_err(|e| e.to_string())?;
        for id in &introduced {
            let rejected = decisions
                .values()
                .flatten()
                .any(|row| row.id == *id && row.status == "rejected");
            if !rejected {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// Change ids this bot added on `branch`. The bot commit also snapshots the cache, so a
    /// writer suggestion that had not reached `main` is on that tip and is not counted.
    fn changes_introduced_on_branch(
        &self,
        store: &Store,
        manuscript_id: &str,
        branch: &str,
        bot_agent_id: Option<&str>,
    ) -> Result<Vec<String>, String> {
        let dir = self.ensure_open_inner(store, manuscript_id)?;
        let repo = DraftRepo::open_working(&dir).map_err(|e| e.to_string())?;
        let Some(bot_oid) = repo.branch_target(branch).map_err(|e| e.to_string())? else {
            return Ok(Vec::new());
        };
        let Some(main_oid) = repo.head_oid().map_err(|e| e.to_string())? else {
            return Ok(Vec::new());
        };
        let Some(base) = repo
            .merge_base(&bot_oid, &main_oid)
            .map_err(|e| e.to_string())?
        else {
            return Ok(Vec::new());
        };
        let base_ids = changes::change_ids_in_commit(&repo, &base).map_err(|e| e.to_string())?;
        let mut ids: Vec<String> = changes::changes_in_commit(&repo, &bot_oid)
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|entry| !base_ids.contains(&entry.id))
            .filter(|entry| change_authored_by_bot(entry, bot_agent_id))
            .map(|entry| entry.id)
            .collect();
        ids.sort();
        ids.dedup();
        Ok(ids)
    }

    /// Comments this bot added on `branch` are marked resolved so the next main commit keeps them.
    /// A checkpoint that already copied the row onto `main` does not exempt it: the
    /// comparison is the branch point, not the current tip. A writer comment that rode along
    /// in the cache snapshot is left alone. The current cache row wins over that snapshot, so
    /// a newer body or a delete is not replaced.
    fn resolve_bot_originated_comments(
        &self,
        store: &Store,
        manuscript_id: &str,
        branch: &str,
        bot_agent_id: Option<&str>,
    ) -> Result<(), String> {
        let dir = self.ensure_open_inner(store, manuscript_id)?;
        let repo = DraftRepo::open_working(&dir).map_err(|e| e.to_string())?;
        let Some(bot_oid) = repo.branch_target(branch).map_err(|e| e.to_string())? else {
            return Ok(());
        };
        let Some(main_oid) = repo.head_oid().map_err(|e| e.to_string())? else {
            return Ok(());
        };
        let Some(base) = repo
            .merge_base(&bot_oid, &main_oid)
            .map_err(|e| e.to_string())?
        else {
            return Ok(());
        };
        let base_ids = sync::comment_rows_in_commit(&repo, &base)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|row| row.comment.id)
            .collect::<std::collections::HashSet<_>>();
        let live = store
            .comments_for_manuscript(manuscript_id)
            .map_err(|e| e.to_string())?;
        let tombs = store
            .comment_tombstones(manuscript_id)
            .map_err(|e| e.to_string())?;
        let tomb_ids = tombs
            .iter()
            .map(|tomb| tomb.comment.id.clone())
            .collect::<std::collections::HashSet<_>>();
        let mut live_by_id: HashMap<String, crate::manuscripts::Comment> = live
            .into_iter()
            .map(|comment| (comment.id.clone(), comment))
            .collect();
        let now = store.now().map_err(|e| e.to_string())?;
        for row in sync::comment_rows_in_commit(&repo, &bot_oid).map_err(|e| e.to_string())? {
            if row.deleted_at.is_some() || base_ids.contains(&row.comment.id) {
                continue;
            }
            if !comment_authored_by_bot(&row.comment, bot_agent_id) {
                continue;
            }
            if tomb_ids.contains(&row.comment.id) {
                continue;
            }
            if let Some(current) = live_by_id.get_mut(&row.comment.id) {
                if current.resolved_at.is_none() {
                    current.resolved_at = Some(now.clone());
                    store
                        .upsert_comment(manuscript_id, current)
                        .map_err(|e| e.to_string())?;
                }
            } else {
                let mut comment = row.comment;
                if comment.resolved_at.is_none() {
                    comment.resolved_at = Some(now.clone());
                }
                store
                    .upsert_comment(manuscript_id, &comment)
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    fn active_record(&self, manuscript_id: &str) -> Option<SessionRecord> {
        self.human_sessions
            .lock()
            .expect("sessions")
            .get(manuscript_id)
            .cloned()
    }

    fn autostart_enabled(&self, manuscript_id: &str) -> bool {
        self.autostart
            .lock()
            .expect("autostart")
            .get(manuscript_id)
            .copied()
            .unwrap_or(true)
    }

    fn session_for_commit(
        &self,
        store: &Store,
        manuscript_id: &str,
    ) -> Result<Option<SessionRecord>, String> {
        if let Some(record) = self.active_record(manuscript_id) {
            return Ok(Some(record));
        }
        if !self.autostart_enabled(manuscript_id) {
            return Ok(None);
        }
        self.begin_editing_session_inner(store, manuscript_id)?;
        Ok(self.active_record(manuscript_id))
    }

    fn begin_editing_session_inner(
        &self,
        store: &Store,
        manuscript_id: &str,
    ) -> Result<String, String> {
        self.autostart
            .lock()
            .expect("autostart")
            .insert(manuscript_id.to_string(), true);
        if let Some(existing) = self.active_record(manuscript_id) {
            return Ok(existing.id);
        }
        let dir = self.ensure_open_inner(store, manuscript_id)?;
        let repo = DraftRepo::open_working(&dir).map_err(|e| e.to_string())?;
        let base = repo.head_oid().map_err(|e| e.to_string())?;
        let id = crate::manuscripts::new_id();
        let record = SessionRecord {
            id: id.clone(),
            author_name: author_name(store),
            started_at: store
                .now()
                .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".into()),
            base_commit: base.clone(),
            ended_at: None,
        };
        sessions::write_session_file(&dir, &record).map_err(|e| e.to_string())?;
        if let Some(oid) = &base {
            repo.point_branch(&format!("session/{id}"), oid)
                .map_err(|e| e.to_string())?;
        }
        self.human_sessions
            .lock()
            .expect("sessions")
            .insert(manuscript_id.to_string(), record);
        Ok(id)
    }

    fn end_editing_session_inner(&self, store: &Store, manuscript_id: &str) -> Result<(), String> {
        let Some(mut record) = self.active_record(manuscript_id) else {
            self.autostart
                .lock()
                .expect("autostart")
                .insert(manuscript_id.to_string(), false);
            return Ok(());
        };
        let prior_ended = record.ended_at.clone();
        record.ended_at = Some(
            store
                .now()
                .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".into()),
        );
        self.human_sessions
            .lock()
            .expect("sessions")
            .insert(manuscript_id.to_string(), record);
        match self.commit_now_inner(
            store,
            manuscript_id,
            "Saved",
            &author_name(store),
            "author@swarmdraft.local",
            false,
        ) {
            Ok(_) => {
                self.human_sessions
                    .lock()
                    .expect("sessions")
                    .remove(manuscript_id);
                self.autostart
                    .lock()
                    .expect("autostart")
                    .insert(manuscript_id.to_string(), false);
                Ok(())
            }
            Err(err) => {
                if let Some(mut current) = self.active_record(manuscript_id) {
                    current.ended_at = prior_ended;
                    self.human_sessions
                        .lock()
                        .expect("sessions")
                        .insert(manuscript_id.to_string(), current);
                }
                Err(err)
            }
        }
    }

    fn ensure_bot_session_inner(
        &self,
        store: &Store,
        manuscript_id: &str,
        bot_agent_id: &str,
    ) -> Result<String, String> {
        let key = (manuscript_id.to_string(), bot_agent_id.to_string());
        let sessions = self.bot_sessions.lock().expect("bot sessions");
        if let Some(s) = sessions.get(&key) {
            return Ok(s.branch.clone());
        }
        drop(sessions);
        let session_id = new_bot_session_id();
        let branch = bot_branch_name(bot_agent_id, &session_id);
        let dir = self.ensure_open_inner(store, manuscript_id)?;
        let repo = DraftRepo::open_working(&dir).map_err(|e| e.to_string())?;
        repo.ensure_bot_branch(&branch)
            .map_err(|e| format!("create bot branch: {e}"))?;
        self.bot_sessions.lock().expect("bot sessions").insert(
            key,
            BotSession {
                branch: branch.clone(),
            },
        );
        Ok(branch)
    }

    fn active_bot_branch(
        &self,
        manuscript_id: &str,
        bot_agent_id: Option<&str>,
        bot_name: &str,
    ) -> Option<String> {
        if let Some(id) = bot_agent_id {
            let key = (manuscript_id.to_string(), id.to_string());
            return self
                .bot_sessions
                .lock()
                .expect("bot sessions")
                .get(&key)
                .map(|s| s.branch.clone());
        }
        let slug = bot_slug(bot_name);
        self.bot_sessions
            .lock()
            .expect("bot sessions")
            .iter()
            .find(|((mid, _), _)| mid == manuscript_id)
            .map(|(_, s)| s.branch.clone())
            .filter(|b| b.starts_with(&format!("bot/{slug}/")))
    }

    fn end_bot_session(&self, manuscript_id: &str, bot_agent_id: Option<&str>, bot_name: &str) {
        let mut sessions = self.bot_sessions.lock().expect("bot sessions");
        if let Some(id) = bot_agent_id {
            sessions.remove(&(manuscript_id.to_string(), id.to_string()));
            return;
        }
        let slug = bot_slug(bot_name);
        sessions.retain(|(mid, _), s| {
            !(mid == manuscript_id && s.branch.starts_with(&format!("bot/{slug}/")))
        });
    }
}

pub(crate) fn path_with_draft_extension(path: &str) -> String {
    let p = Path::new(path);
    let file_name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if file_name.len() >= 6 {
        let lower = file_name.to_ascii_lowercase();
        if lower.ends_with(".draft") {
            return path.to_string();
        }
    }
    if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
        let replace_ext = ext.len() >= 2
            && ext.len() <= 4
            && ext.chars().all(|c| c.is_ascii_alphanumeric())
            && !ext.chars().all(|c| c.is_ascii_digit());
        if replace_ext {
            let stem = p
                .file_stem()
                .and_then(|s| s.to_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("Untitled draft");
            return match p.parent() {
                Some(parent) if parent.as_os_str().is_empty() => format!("{stem}.draft"),
                Some(parent) => parent
                    .join(format!("{stem}.draft"))
                    .to_string_lossy()
                    .into_owned(),
                None => format!("{stem}.draft"),
            };
        }
    }
    format!("{path}.draft")
}

pub(crate) fn unique_draft_path(dir: &Path, base: &str) -> PathBuf {
    let first = dir.join(format!("{base}.draft"));
    if !first.exists() {
        return first;
    }
    for n in 2..1000 {
        let p = dir.join(format!("{base} ({n}).draft"));
        if !p.exists() {
            return p;
        }
    }
    dir.join(format!("{base}-{}.draft", now_ms()))
}

fn format_when_human(unix: i64) -> String {
    Local
        .timestamp_opt(unix, 0)
        .single()
        .map(|dt| dt.format("%b %d, %Y, %I:%M %p").to_string())
        .unwrap_or_else(|| "unknown time".into())
}

fn head_oid_from_archive(archive: &Path) -> Result<Option<String>, String> {
    let unpacked = tempfile::tempdir().map_err(|e| e.to_string())?;
    format::unpack_draft(archive, unpacked.path()).map_err(|e| e.to_string())?;
    let bare = unpacked.path().join(REPO_DIR);
    let work = unpacked.path().join("work");
    copy_bare_to_working(&bare, &work).map_err(|e| e.to_string())?;
    DraftRepo::open_working(&work)
        .map_err(|e| e.to_string())?
        .head_oid()
        .map_err(|e| e.to_string())
}

fn recovery_offer_if_worktree_newer(
    work: &Path,
    draft_path: &str,
    manuscript_id: &str,
    file_head: &Option<String>,
) -> Result<Option<DraftRecoveryOffer>, String> {
    let Some(file_oid) = file_head else {
        return Ok(None);
    };
    if !work.join(".git").is_dir() {
        return Ok(None);
    }
    let repo = DraftRepo::open_working(work).map_err(|e| e.to_string())?;
    let Some(work_oid) = repo.head_oid().map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    if work_oid == *file_oid {
        return Ok(None);
    }
    Ok(Some(DraftRecoveryOffer {
        manuscript_id: manuscript_id.to_string(),
        draft_path: draft_path.to_string(),
    }))
}

pub(crate) fn sanitize_filename(title: &str) -> String {
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

/// Put saved bot writes back into SQLite. Tokens whose document update is in the cache
/// (or that had no document update) are returned so a commit can drop them. A document
/// update that does not apply stays pending and is not cleared.
fn apply_pending_bot_writes(
    store: &Store,
    manuscript_id: &str,
    pending: &[PendingBotWrite],
) -> Result<Vec<u64>, String> {
    if pending.is_empty() {
        return Ok(Vec::new());
    }
    let tombstones = store
        .comment_tombstones(manuscript_id)
        .map_err(|e| e.to_string())?;
    let mut applied = Vec::with_capacity(pending.len());
    for write in pending {
        if let Some(comment) = &write.comment {
            let buried = tombstones.iter().any(|tomb| tomb.comment.id == comment.id);
            if !buried
                && store
                    .get_comment(&comment.id)
                    .map_err(|e| e.to_string())?
                    .is_none()
            {
                store
                    .insert_comment(manuscript_id, comment)
                    .map_err(|e| e.to_string())?;
            }
        }
        let doc_ok = if let (Some(doc_id), Some(update)) = (&write.doc_id, &write.doc_update) {
            match store.append_doc_update_unless_present(doc_id, update) {
                Ok(()) => true,
                Err(e) => {
                    eprintln!(
                        "draft bot document update stays pending; it does not apply to the rebuilt chapter: {e}"
                    );
                    false
                }
            }
        } else {
            true
        };
        if doc_ok {
            applied.push(write.token);
        }
    }
    Ok(applied)
}

struct FinishMainCommit(Arc<DraftService>);

impl Drop for FinishMainCommit {
    fn drop(&mut self) {
        self.0.finish_main_commit();
    }
}

/// Commit the open book on `main` without blocking the caller. Comment create, reply,
/// resolve, reopen, and delete use this so git never runs on the UI or request thread.
/// Restore and open wait until the commit finishes.
pub fn queue_main_commit(
    drafts: &Arc<DraftService>,
    store: &Store,
    manuscript_id: &str,
    message: &str,
) {
    drafts.begin_main_commit();
    spawn_main_commit(drafts, store, manuscript_id, message);
}

/// Write a comment change and mark its commit as queued under the same op lock.
/// Restore or open cannot rebuild the cache in the gap between the two, and a reply
/// that arrives while one of them holds the lock waits until that rebuild has finished.
pub fn commit_comment_mutation<T>(
    drafts: &Arc<DraftService>,
    store: &Store,
    manuscript_id: &str,
    message: &str,
    write: impl FnOnce(&Store) -> Result<T, String>,
) -> Result<T, String> {
    let result = {
        let _guard = drafts.op.lock().expect("draft op");
        let result = write(store)?;
        drafts.begin_main_commit();
        result
    };
    spawn_main_commit(drafts, store, manuscript_id, message);
    Ok(result)
}

fn spawn_main_commit(
    drafts: &Arc<DraftService>,
    store: &Store,
    manuscript_id: &str,
    message: &str,
) {
    let drafts = Arc::clone(drafts);
    let store = store.clone();
    let manuscript_id = manuscript_id.to_string();
    let message = message.to_string();
    let work = move || {
        let _finish = FinishMainCommit(Arc::clone(&drafts));
        let name = author_name(&store);
        if let Err(e) = drafts.commit_now(
            &store,
            &manuscript_id,
            &message,
            &name,
            "author@swarmdraft.local",
        ) {
            eprintln!("draft comment commit: {e}");
        }
    };
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            let _task = handle.spawn(async move {
                if let Err(e) = tokio::task::spawn_blocking(work).await {
                    eprintln!("draft comment commit task failed: {e}");
                }
            });
        }
        Err(_) => {
            std::thread::spawn(work);
        }
    }
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod path_tests {
    use super::path_with_draft_extension;

    #[test]
    fn save_as_appends_draft_extension() {
        assert!(path_with_draft_extension("/tmp/My Book").ends_with("My Book.draft"));
        assert!(path_with_draft_extension("/tmp/book.txt").ends_with("book.draft"));
        assert_eq!(
            path_with_draft_extension("/tmp/book.draft"),
            "/tmp/book.draft"
        );
        assert_eq!(
            path_with_draft_extension("/tmp/Vol. 2"),
            "/tmp/Vol. 2.draft"
        );
        assert_eq!(
            path_with_draft_extension("/tmp/Mr. Smith"),
            "/tmp/Mr. Smith.draft"
        );
        assert_eq!(
            path_with_draft_extension("/tmp/book.DRAFT"),
            "/tmp/book.DRAFT"
        );
    }
}

#[cfg(test)]
mod save_as_lock_tests {
    use super::*;
    use std::sync::{mpsc, Arc};
    use std::thread;
    use std::time::{Duration, Instant};

    /// The native picker is the `pick` closure. While it runs, the op lock must be free so a
    /// checkpoint or bot commit (both `with_op`) does not wait for the dialog.
    #[test]
    fn save_as_picker_does_not_hold_op_lock() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let stored = store.create_blank_manuscript_with_progress(None).unwrap();
        let id = stored.manuscript.id.clone();
        let svc = Arc::new(DraftService::new(
            store.data_dir().to_path_buf(),
            "0.2.2".into(),
        ));
        let (entered_tx, entered_rx) = mpsc::channel::<()>();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let svc_pick = Arc::clone(&svc);
        let store_pick = store.clone();
        let id_pick = id.clone();
        let path = dir.path().join("picked.draft");
        let path_pick = path.clone();
        let worker = thread::spawn(move || {
            svc_pick.save_as_with_picker(&store_pick, &id_pick, || {
                let free = svc_pick.op.try_lock();
                assert!(
                    free.is_ok(),
                    "draft op lock held while the Save As path is being chosen"
                );
                drop(free);
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Some(path_pick.to_string_lossy().into_owned())
            })
        });
        entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("picker did not start");
        let started = Instant::now();
        svc.with_op(|| Ok(()))
            .expect("draft op while picker is open");
        assert!(
            started.elapsed() < Duration::from_millis(200),
            "a draft op waited for Save As path selection"
        );
        release_tx.send(()).unwrap();
        let saved = worker.join().unwrap().expect("save as");
        assert_eq!(saved.as_deref(), Some(path.to_str().unwrap()));
        assert!(
            path.is_file(),
            "draft file was not written after the picker"
        );
        assert_eq!(
            store.draft_file_path(&id).unwrap().as_deref(),
            Some(path.to_str().unwrap())
        );
    }

    /// The caller returns while the draft op lock is still held, so the git commit cannot
    /// be running on this thread.
    #[test]
    fn comment_commit_queue_returns_while_the_op_lock_is_held() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let stored = store.create_blank_manuscript_with_progress(None).unwrap();
        let id = stored.manuscript.id.clone();
        let chapter = stored
            .sections
            .iter()
            .find(|s| s.section.kind == "chapter")
            .unwrap();
        let svc = Arc::new(DraftService::new(
            store.data_dir().to_path_buf(),
            "0.2.2".into(),
        ));
        svc.commit_now(&store, &id, "Baseline", "Author", "author@swarmdraft.local")
            .unwrap();
        store
            .insert_comment(
                &id,
                &crate::manuscripts::Comment {
                    id: "cq1".into(),
                    section_id: chapter.section.id.clone(),
                    block_id: None,
                    quote: None,
                    body: "Queued.".into(),
                    thread_id: Some("cq1".into()),
                    author: crate::manuscripts::Author {
                        kind: "human".into(),
                        id: "local".into(),
                        name: "Author".into(),
                    },
                    created_at: "2026-03-01T00:00:00.000Z".into(),
                    resolved_at: None,
                },
            )
            .unwrap();
        let guard = svc.op.lock().expect("draft op");
        let started = Instant::now();
        queue_main_commit(&svc, &store, &id, "Comment reply");
        assert!(
            started.elapsed() < Duration::from_millis(200),
            "queueing a comment commit waited on git"
        );
        drop(guard);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let repo = DraftRepo::open_working(&svc.worktree_path(&id)).unwrap();
            let head = repo.head_oid().unwrap().unwrap();
            let message = repo.commit_message(&head).unwrap();
            if message.starts_with("Comment reply") {
                let bytes = repo
                    .file_bytes(&head, "comments/cq1.json")
                    .unwrap()
                    .expect("queued comment file");
                assert!(String::from_utf8(bytes).unwrap().contains("Queued."));
                break;
            }
            assert!(
                Instant::now() < deadline,
                "queued comment commit did not land"
            );
            thread::sleep(Duration::from_millis(30));
        }
    }

    fn root_comment(section_id: &str) -> crate::manuscripts::Comment {
        crate::manuscripts::Comment {
            id: "cq1".into(),
            section_id: section_id.into(),
            block_id: None,
            quote: None,
            body: "Root.".into(),
            thread_id: Some("cq1".into()),
            author: crate::manuscripts::Author {
                kind: "human".into(),
                id: "local".into(),
                name: "Author".into(),
            },
            created_at: "2026-03-01T00:00:00.000Z".into(),
            resolved_at: None,
        }
    }

    /// Reply, then restore, before the queued commit runs. The reply is still there.
    #[test]
    fn queued_reply_survives_restore_that_starts_before_the_commit() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let stored = store.create_blank_manuscript_with_progress(None).unwrap();
        let id = stored.manuscript.id.clone();
        let section_id = stored
            .sections
            .iter()
            .find(|s| s.section.kind == "chapter")
            .unwrap()
            .section
            .id
            .clone();
        let svc = Arc::new(DraftService::new(
            store.data_dir().to_path_buf(),
            "0.2.2".into(),
        ));
        let draft_path = dir.path().join("drafts").join("race-restore.draft");
        store
            .set_draft_file_path(&id, &draft_path.to_string_lossy())
            .unwrap();
        store
            .insert_comment(&id, &root_comment(&section_id))
            .unwrap();
        let baseline = svc
            .commit_now(&store, &id, "Baseline", "Author", "author@swarmdraft.local")
            .unwrap()
            .expect("baseline");
        store
            .human_comment_reply(&id, &section_id, "cq1", "Queued reply.", "Author", "local")
            .unwrap();
        let guard = svc.op.lock().expect("draft op");
        queue_main_commit(&svc, &store, &id, "Comment reply");
        let svc_restore = Arc::clone(&svc);
        let store_restore = store.clone();
        let id_restore = id.clone();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            tx.send(svc_restore.restore(&store_restore, &id_restore, &baseline, "Author"))
                .ok();
        });
        drop(guard);
        let restored = rx
            .recv_timeout(Duration::from_secs(8))
            .expect("restore did not finish");
        restored.expect("restore");
        assert!(store
            .comments_for_manuscript(&id)
            .unwrap()
            .iter()
            .any(|c| c.body == "Queued reply."));
    }

    /// Reply, then reopen the packed book, before the queued commit runs. The reply is still there.
    #[test]
    fn queued_reply_survives_reopen_that_starts_before_the_commit() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let stored = store.create_blank_manuscript_with_progress(None).unwrap();
        let id = stored.manuscript.id.clone();
        let section_id = stored
            .sections
            .iter()
            .find(|s| s.section.kind == "chapter")
            .unwrap()
            .section
            .id
            .clone();
        let svc = Arc::new(DraftService::new(
            store.data_dir().to_path_buf(),
            "0.2.2".into(),
        ));
        let draft_path = dir.path().join("drafts").join("race-reopen.draft");
        let path = draft_path.to_string_lossy().into_owned();
        store.set_draft_file_path(&id, &path).unwrap();
        store
            .insert_comment(&id, &root_comment(&section_id))
            .unwrap();
        svc.commit_now(&store, &id, "Baseline", "Author", "author@swarmdraft.local")
            .unwrap()
            .expect("baseline");
        store
            .human_comment_reply(&id, &section_id, "cq1", "Queued reply.", "Author", "local")
            .unwrap();
        let guard = svc.op.lock().expect("draft op");
        queue_main_commit(&svc, &store, &id, "Comment reply");
        let svc_open = Arc::clone(&svc);
        let store_open = store.clone();
        let path_open = path.clone();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            tx.send(svc_open.open_draft_path(&store_open, &path_open, true))
                .ok();
        });
        drop(guard);
        let opened = rx
            .recv_timeout(Duration::from_secs(8))
            .expect("reopen did not finish");
        let opened = opened.expect("reopen").expect("draft opened");
        assert!(store
            .comments_for_manuscript(&opened.manuscript_id)
            .unwrap()
            .iter()
            .any(|c| c.body == "Queued reply."));
    }

    /// Reply while restore already holds the op lock. The reply is written after the rebuild
    /// and the queued commit keeps it.
    #[test]
    fn reply_while_restore_holds_the_lock_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let stored = store.create_blank_manuscript_with_progress(None).unwrap();
        let id = stored.manuscript.id.clone();
        let section_id = stored
            .sections
            .iter()
            .find(|s| s.section.kind == "chapter")
            .unwrap()
            .section
            .id
            .clone();
        let svc = Arc::new(DraftService::new(
            store.data_dir().to_path_buf(),
            "0.2.2".into(),
        ));
        let draft_path = dir.path().join("drafts").join("race-inside-restore.draft");
        store
            .set_draft_file_path(&id, &draft_path.to_string_lossy())
            .unwrap();
        store
            .insert_comment(&id, &root_comment(&section_id))
            .unwrap();
        let baseline = svc
            .commit_now(&store, &id, "Baseline", "Author", "author@swarmdraft.local")
            .unwrap()
            .expect("baseline");
        let (entered_tx, entered_rx) = mpsc::channel::<()>();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        *svc.op_entered.lock().expect("op entered") = Some(Box::new(move || {
            entered_tx.send(()).ok();
            release_rx.recv().ok();
        }));
        let svc_restore = Arc::clone(&svc);
        let store_restore = store.clone();
        let id_restore = id.clone();
        let restore_thread = thread::spawn(move || {
            svc_restore.restore(&store_restore, &id_restore, &baseline, "Author")
        });
        entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("restore did not take the lock");
        let svc_reply = Arc::clone(&svc);
        let store_reply = store.clone();
        let id_reply = id.clone();
        let section_reply = section_id.clone();
        let reply_thread = thread::spawn(move || {
            commit_comment_mutation(&svc_reply, &store_reply, &id_reply, "Comment reply", |s| {
                s.human_comment_reply(
                    &id_reply,
                    &section_reply,
                    "cq1",
                    "During restore.",
                    "Author",
                    "local",
                )
                .map(|_| ())
                .map_err(|e| e.to_string())
            })
        });
        let quiet_until = Instant::now() + Duration::from_millis(200);
        while Instant::now() < quiet_until {
            assert!(
                store
                    .comments_for_manuscript(&id)
                    .unwrap()
                    .iter()
                    .all(|c| c.body != "During restore."),
                "reply was written while restore held the lock"
            );
            thread::sleep(Duration::from_millis(20));
        }
        release_tx.send(()).unwrap();
        restore_thread
            .join()
            .expect("restore thread")
            .expect("restore");
        reply_thread.join().expect("reply thread").expect("reply");
        assert!(store
            .comments_for_manuscript(&id)
            .unwrap()
            .iter()
            .any(|c| c.body == "During restore."));
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let repo = DraftRepo::open_working(&svc.worktree_path(&id)).unwrap();
            let head = repo.head_oid().unwrap().unwrap();
            let message = repo.commit_message(&head).unwrap();
            if message.starts_with("Comment reply") {
                let bytes = repo
                    .file_bytes(&head, "comments/cq1.json")
                    .unwrap()
                    .expect("queued reply file");
                assert!(String::from_utf8(bytes)
                    .unwrap()
                    .contains("During restore."));
                break;
            }
            assert!(
                Instant::now() < deadline,
                "queued reply commit did not land"
            );
            thread::sleep(Duration::from_millis(30));
        }
    }

    fn bot_comment(section_id: &str, body: &str) -> crate::manuscripts::Comment {
        crate::manuscripts::Comment {
            id: "cbot-race".into(),
            section_id: section_id.into(),
            block_id: None,
            quote: None,
            body: body.into(),
            thread_id: Some("cbot-race".into()),
            author: crate::manuscripts::Author {
                kind: "agent".into(),
                id: "agent-test-1".into(),
                name: "Line Editor".into(),
            },
            created_at: "2026-03-01T00:00:00.000Z".into(),
            resolved_at: None,
        }
    }

    fn record_bot_comment(
        svc: &DraftService,
        store: &Store,
        manuscript_id: &str,
        comment: &crate::manuscripts::Comment,
    ) {
        svc.record_bot_write(
            manuscript_id,
            BotRetention {
                comment: Some(comment.clone()),
                doc_id: None,
                doc_update: None,
            },
            || {
                store
                    .insert_comment(manuscript_id, comment)
                    .map_err(|e| e.to_string())
            },
        )
        .expect("record bot comment");
    }

    fn assert_comment_body(store: &Store, manuscript_id: &str, body: &str) {
        assert!(
            store
                .comments_for_manuscript(manuscript_id)
                .unwrap()
                .iter()
                .any(|comment| comment.body == body),
            "missing bot comment {body}"
        );
    }

    fn bot_tree_text(svc: &DraftService, manuscript_id: &str, path: &str) -> String {
        let repo = DraftRepo::open_working(&svc.worktree_path(manuscript_id)).unwrap();
        let tips = repo.search_ref_tips().unwrap();
        let tip = tips
            .iter()
            .find(|tip| tip.name.starts_with("bot/"))
            .expect("bot tip");
        let bytes = repo
            .file_bytes(&tip.oid, path)
            .unwrap()
            .unwrap_or_else(|| panic!("missing {path} on {}", tip.name));
        String::from_utf8(bytes).unwrap()
    }

    /// Insert the bot comment, then restore, before `commit_bot_suggestion` runs.
    #[test]
    fn bot_comment_survives_restore_before_its_commit() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let stored = store.create_blank_manuscript_with_progress(None).unwrap();
        let id = stored.manuscript.id.clone();
        let section_id = stored
            .sections
            .iter()
            .find(|s| s.section.kind == "chapter")
            .unwrap()
            .section
            .id
            .clone();
        let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.2".into());
        let draft_path = dir.path().join("drafts").join("bot-restore.draft");
        store
            .set_draft_file_path(&id, &draft_path.to_string_lossy())
            .unwrap();
        let baseline = svc
            .commit_now(&store, &id, "Baseline", "Author", "author@swarmdraft.local")
            .unwrap()
            .expect("baseline");
        let comment = bot_comment(&section_id, "Bot note before restore.");
        record_bot_comment(&svc, &store, &id, &comment);
        svc.restore(&store, &id, &baseline, "Author")
            .expect("restore");
        assert_comment_body(&store, &id, "Bot note before restore.");
        svc.commit_bot_suggestion(&store, &id, "agent-test-1", "Line Editor", "Bot comment")
            .unwrap()
            .expect("bot comment commit");
        assert_comment_body(&store, &id, "Bot note before restore.");
        let text = bot_tree_text(&svc, &id, "comments/cbot-race.json");
        assert!(
            text.contains("Bot note before restore."),
            "commit stored the rebuilt cache without the write: {text}"
        );
    }

    /// Insert the bot comment, then reopen the packed book, before the bot commit runs.
    #[test]
    fn bot_comment_survives_reopen_before_its_commit() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let stored = store.create_blank_manuscript_with_progress(None).unwrap();
        let id = stored.manuscript.id.clone();
        let section_id = stored
            .sections
            .iter()
            .find(|s| s.section.kind == "chapter")
            .unwrap()
            .section
            .id
            .clone();
        let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.2".into());
        let path = dir
            .path()
            .join("drafts")
            .join("bot-reopen.draft")
            .to_string_lossy()
            .into_owned();
        store.set_draft_file_path(&id, &path).unwrap();
        svc.commit_now(&store, &id, "Baseline", "Author", "author@swarmdraft.local")
            .unwrap()
            .expect("baseline");
        let comment = bot_comment(&section_id, "Bot note before reopen.");
        record_bot_comment(&svc, &store, &id, &comment);
        let opened = svc
            .open_draft_path(&store, &path, true)
            .expect("reopen")
            .expect("draft opened");
        assert_comment_body(&store, &opened.manuscript_id, "Bot note before reopen.");
        svc.commit_bot_suggestion(
            &store,
            &opened.manuscript_id,
            "agent-test-1",
            "Line Editor",
            "Bot comment",
        )
        .unwrap()
        .expect("bot comment commit");
        assert_comment_body(&store, &opened.manuscript_id, "Bot note before reopen.");
        let text = bot_tree_text(&svc, &opened.manuscript_id, "comments/cbot-race.json");
        assert!(text.contains("Bot note before reopen."), "{text}");
    }

    /// Insert while restore already holds the op lock, before the cache rebuild.
    /// The write returns without waiting on that lock, and both the cache and the bot commit keep it.
    #[test]
    fn bot_comment_inserted_while_restore_holds_the_lock_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let stored = store.create_blank_manuscript_with_progress(None).unwrap();
        let id = stored.manuscript.id.clone();
        let section_id = stored
            .sections
            .iter()
            .find(|s| s.section.kind == "chapter")
            .unwrap()
            .section
            .id
            .clone();
        let svc = Arc::new(DraftService::new(
            store.data_dir().to_path_buf(),
            "0.2.2".into(),
        ));
        let draft_path = dir.path().join("drafts").join("bot-inside-restore.draft");
        store
            .set_draft_file_path(&id, &draft_path.to_string_lossy())
            .unwrap();
        let baseline = svc
            .commit_now(&store, &id, "Baseline", "Author", "author@swarmdraft.local")
            .unwrap()
            .expect("baseline");
        let (entered_tx, entered_rx) = mpsc::channel::<()>();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        *svc.op_entered.lock().expect("op entered") = Some(Box::new(move || {
            entered_tx.send(()).ok();
            release_rx.recv().ok();
        }));
        let svc_restore = Arc::clone(&svc);
        let store_restore = store.clone();
        let id_restore = id.clone();
        let restore_thread = thread::spawn(move || {
            svc_restore.restore(&store_restore, &id_restore, &baseline, "Author")
        });
        entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("restore did not take the lock");
        let svc_write = Arc::clone(&svc);
        let store_write = store.clone();
        let id_write = id.clone();
        let section_write = section_id.clone();
        let write_thread = thread::spawn(move || {
            let comment = bot_comment(&section_write, "During restore.");
            record_bot_comment(&svc_write, &store_write, &id_write, &comment);
            svc_write
                .commit_bot_suggestion(
                    &store_write,
                    &id_write,
                    "agent-test-1",
                    "Line Editor",
                    "Bot comment",
                )
                .expect("bot comment commit")
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let present = store
                .comments_for_manuscript(&id)
                .unwrap()
                .iter()
                .any(|comment| comment.body == "During restore.");
            if present {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "bot comment was not saved while restore held the lock"
            );
            thread::sleep(Duration::from_millis(20));
        }
        assert!(
            svc.op.try_lock().is_err(),
            "restore released the lock before the bot comment was saved"
        );
        release_tx.send(()).unwrap();
        restore_thread
            .join()
            .expect("restore thread")
            .expect("restore");
        assert_comment_body(&store, &id, "During restore.");
        write_thread
            .join()
            .expect("write thread")
            .expect("bot commit");
        assert_comment_body(&store, &id, "During restore.");
        let text = bot_tree_text(&svc, &id, "comments/cbot-race.json");
        assert!(text.contains("During restore."), "{text}");
    }

    /// A suggestion mark saved by the bot, then restored before its commit, stays in the chapter
    /// and is what the bot commit records.
    #[test]
    fn bot_suggestion_survives_restore_before_its_commit() {
        use yrs::{ReadTxn, Transact};

        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let stored = store.create_blank_manuscript_with_progress(None).unwrap();
        let id = stored.manuscript.id.clone();
        let doc_id = stored
            .sections
            .iter()
            .find(|s| s.section.kind == "chapter")
            .unwrap()
            .section
            .doc_id
            .clone();
        let svc = DraftService::new(store.data_dir().to_path_buf(), "0.2.2".into());
        let draft_path = dir
            .path()
            .join("drafts")
            .join("bot-suggestion-restore.draft");
        store
            .set_draft_file_path(&id, &draft_path.to_string_lossy())
            .unwrap();
        let baseline_doc = crate::content::new_doc();
        crate::content::encode(
            &baseline_doc,
            &serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"version-one"}]}]}),
        )
        .unwrap();
        let baseline_state = baseline_doc
            .transact()
            .encode_state_as_update_v1(&yrs::StateVector::default());
        store.replace_doc_state(&doc_id, &baseline_state).unwrap();
        let baseline = svc
            .commit_now(&store, &id, "Baseline", "Author", "author@swarmdraft.local")
            .unwrap()
            .expect("baseline");
        let doc = store.load_doc(&doc_id).unwrap();
        let since = crate::manuscripts::state_vector(&doc);
        crate::content::encode(
            &doc,
            &serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[{
                "type":"text",
                "text":"guttered",
                "marks":[{"type":"suggestion_insert","attrs":{"id":"chg-race","author":"agent:agent-test-1","ts":"t"}}]
            }]}]}),
        )
        .unwrap();
        let update = crate::manuscripts::doc_update_since(&doc, &since);
        svc.record_bot_write(
            &id,
            BotRetention {
                comment: None,
                doc_id: Some(doc_id.clone()),
                doc_update: Some(update.clone()),
            },
            || {
                store
                    .append_doc_update(&doc_id, &update)
                    .map_err(|e| e.to_string())
            },
        )
        .expect("record bot suggestion");
        svc.restore(&store, &id, &baseline, "Author")
            .expect("restore");
        let markdown =
            crate::content::markdown(&crate::content::decode(&store.load_doc(&doc_id).unwrap()));
        assert!(
            markdown.contains("guttered"),
            "restore dropped the bot suggestion: {markdown}"
        );
        assert!(markdown.contains("version-one"), "{markdown}");
        svc.commit_bot_suggestion(
            &store,
            &id,
            "agent-test-1",
            "Line Editor",
            "Bot suggestions",
        )
        .unwrap()
        .expect("bot suggestion commit");
        let changes = bot_tree_text(&svc, &id, "review/changes.json");
        assert!(
            changes.contains("chg-race"),
            "commit stored the rebuilt cache without the suggestion: {changes}"
        );
    }
}
