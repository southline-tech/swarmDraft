//! swarmDraft desktop backend.
//!
//! Module ownership:
//! - `storage`: local data directory and SQLite (manuscript metadata, Yjs updates, backups).
//! - `backup`: full-project .zip backup and validated restore (RAD-224).
//! - `agents`: agent principals and hashed per-agent bearer tokens (RAD-205).
//! - `migrate`: first-run copy of the pre-rename data folders (#43).
//! - `mcp`: in-app MCP server bound to 127.0.0.1 with per-agent bearer tokens (RAD-205/209/210).

pub mod agent_access;
pub mod agents;
pub mod anchor;
pub mod backup;
pub mod content;
pub mod dictionary;
pub mod export;
pub mod manuscripts;
pub mod mcp;
pub mod migrate;
pub mod notes;
pub mod opening_progress;
pub mod pairing;
pub mod save_copy;
pub mod storage;

use serde::Serialize;
use std::sync::Arc;
use tauri::Emitter;
use tauri::Manager;

use dictionary::{
    spell_dictionary_add, spell_dictionary_ignore, spell_dictionary_list, spell_dictionary_remove,
    spell_lint_paragraph,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    data_dir: String,
    schema_version: i64,
    /// OS account display name for seeding track-changes profile (#57).
    computer_name: String,
}

fn os_user_display_name() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Author".to_string())
}

#[tauri::command]
fn app_info(
    app: tauri::AppHandle,
    store: tauri::State<'_, storage::Store>,
) -> Result<AppInfo, String> {
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        data_dir: store.data_dir().display().to_string(),
        schema_version: store.schema_version().map_err(|e| e.to_string())?,
        computer_name: os_user_display_name(),
    })
}

fn err(e: storage::StorageError) -> String {
    e.to_string()
}

#[tauri::command]
fn agents_list(store: tauri::State<'_, storage::Store>) -> Result<Vec<agents::Agent>, String> {
    store.list_agents().map_err(err)
}

#[tauri::command]
fn agents_primary_id(store: tauri::State<'_, storage::Store>) -> Result<Option<String>, String> {
    store.primary_agent_id().map_err(err)
}

#[tauri::command]
fn agent_create(
    store: tauri::State<'_, storage::Store>,
    name: String,
    color: String,
) -> Result<agents::Agent, String> {
    store.create_agent(&name, &color).map_err(err)
}

#[tauri::command]
fn set_user_display_name(
    store: tauri::State<'_, storage::Store>,
    name: String,
) -> Result<String, String> {
    store.set_user_display_name(&name).map_err(err)
}

#[tauri::command]
fn agent_revoke(store: tauri::State<'_, storage::Store>, agent_id: String) -> Result<(), String> {
    store.revoke_agent(&agent_id).map_err(err)
}

#[tauri::command]
fn agent_tokens_list(
    store: tauri::State<'_, storage::Store>,
    agent_id: String,
) -> Result<Vec<agents::TokenInfo>, String> {
    store.list_tokens(&agent_id).map_err(err)
}

#[tauri::command]
fn agent_token_create(
    store: tauri::State<'_, storage::Store>,
    agent_id: String,
    scopes: Option<Vec<String>>,
) -> Result<agents::NewToken, String> {
    store
        .create_token(&agent_id, scopes.as_deref())
        .map_err(err)
}

#[tauri::command]
fn agent_token_revoke(
    store: tauri::State<'_, storage::Store>,
    token_id: String,
) -> Result<(), String> {
    store.revoke_token(&token_id).map_err(err)
}

#[tauri::command]
fn list_pending_pairings(
    store: tauri::State<'_, storage::Store>,
) -> Result<Vec<pairing::PairingSummary>, String> {
    store.list_pending_pairings().map_err(err)
}

#[tauri::command]
fn approve_pairing(
    store: tauri::State<'_, storage::Store>,
    app: tauri::AppHandle,
    pairing_id: String,
    scopes: Option<Vec<String>>,
    context_manuscript_id: Option<String>,
) -> Result<agents::Agent, String> {
    let (agent, _token) = store
        .approve_pairing(
            &pairing_id,
            scopes.as_deref(),
            context_manuscript_id.as_deref(),
        )
        .map_err(err)?;
    let _ = app.emit("agents-changed", ());
    Ok(agent)
}

#[tauri::command]
fn agents_draft_access_list(
    store: tauri::State<'_, storage::Store>,
) -> Result<Vec<agent_access::AgentDraftAccess>, String> {
    store.list_agents_draft_access().map_err(err)
}

#[tauri::command]
fn agent_set_draft_access_mode(
    store: tauri::State<'_, storage::Store>,
    agent_id: String,
    mode: String,
) -> Result<(), String> {
    store
        .set_agent_manuscript_access_mode(&agent_id, &mode)
        .map_err(err)
}

#[tauri::command]
fn agent_grant_draft(
    store: tauri::State<'_, storage::Store>,
    agent_id: String,
    manuscript_id: String,
) -> Result<(), String> {
    store
        .grant_agent_manuscript(&agent_id, &manuscript_id)
        .map_err(err)
}

#[tauri::command]
fn agent_revoke_draft(
    store: tauri::State<'_, storage::Store>,
    agent_id: String,
    manuscript_id: String,
) -> Result<(), String> {
    store
        .revoke_agent_manuscript(&agent_id, &manuscript_id)
        .map_err(err)
}

#[tauri::command]
fn agents_bulk_grant_current_draft(
    store: tauri::State<'_, storage::Store>,
    agent_ids: Vec<String>,
    manuscript_id: String,
) -> Result<(), String> {
    store
        .bulk_grant_manuscript(&agent_ids, &manuscript_id)
        .map_err(err)
}

#[tauri::command]
fn agents_bulk_grant_all_drafts(
    store: tauri::State<'_, storage::Store>,
    agent_ids: Vec<String>,
) -> Result<(), String> {
    store.bulk_grant_all_manuscripts(&agent_ids).map_err(err)
}

#[tauri::command]
fn agents_bulk_revoke_all_drafts(
    store: tauri::State<'_, storage::Store>,
    agent_ids: Vec<String>,
) -> Result<(), String> {
    store.bulk_revoke_all_draft_access(&agent_ids).map_err(err)
}

#[tauri::command]
fn deny_pairing(store: tauri::State<'_, storage::Store>, pairing_id: String) -> Result<(), String> {
    store.deny_pairing(&pairing_id).map_err(err)
}

/// Write a full backup. The destination is chosen here, never taken from the webview (#73):
/// only a native save dialog opened from Rust, so every write needs the user's gesture.
/// There is no unattended variant. The archive is built in Rust and written atomically.
/// Returns `Ok(true)` when written, `Ok(false)` if the user cancelled; details go to the log.
#[tauri::command]
async fn create_backup(
    app: tauri::AppHandle,
    window: tauri::Window,
    store: tauri::State<'_, storage::Store>,
) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    let store = store.inner().clone();
    let version = app.package_info().version.to_string();
    let mut data_dirs = vec![store.data_dir().to_path_buf()];
    data_dirs.extend(app.path().app_data_dir().ok());
    data_dirs.extend(app.path().app_local_data_dir().ok());
    tauri::async_runtime::spawn_blocking(move || {
        // One backup or restore at a time, held from before the dialog to the end (#86).
        let lock = app.state::<backup::OpLock>();
        let held = lock.try_acquire().map_err(str::to_string)?;
        let picked = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("Save backup")
            .set_file_name(backup::backup_file_name(&time_stamp()))
            .add_filter("Backup", &["zip"])
            .blocking_save_file();
        let Some(picked) = picked else {
            return Ok(false);
        };
        let dest = picked.into_path().map_err(|e| {
            eprintln!("backup: bad dialog path: {e}");
            "backup failed".to_string()
        })?;
        let res = backup::create_backup_checked(&held, &store, &version, &data_dirs, &dest);
        match res {
            Ok(p) => {
                eprintln!("backup: wrote {}", p.display());
                Ok(true)
            }
            Err(e) => {
                eprintln!("backup: failed: {e}");
                Err("backup failed".to_string())
            }
        }
    })
    .await
    .map_err(|e| {
        eprintln!("backup: task failed: {e}");
        "backup failed".to_string()
    })?
}

fn time_stamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_default()
}

/// "Save a copy" from the save-failure banner: the frontend sends only the .docx bytes it
/// built from the in-memory manuscript (and the title for the default file name). The
/// destination is picked here in the native save dialog, never taken from the webview, and
/// written atomically. Returns the path written, or `None` if the user cancelled, or `busy`
/// while a backup, restore or another copy holds the shared lock (#100).
#[tauri::command]
async fn save_manuscript_copy(
    app: tauri::AppHandle,
    window: tauri::Window,
    store: tauri::State<'_, storage::Store>,
    title: String,
    bytes: Vec<u8>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let mut data_dirs = vec![store.data_dir().to_path_buf()];
    data_dirs.extend(app.path().app_data_dir().ok());
    data_dirs.extend(app.path().app_local_data_dir().ok());
    tauri::async_runtime::spawn_blocking(move || {
        // Same lock as backup and restore, held from before the dialog to the end (#100).
        let lock = app.state::<backup::OpLock>();
        let held = lock.try_acquire().map_err(str::to_string)?;
        let picked = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("Save a copy")
            .set_file_name(save_copy::default_file_name(&title))
            .add_filter("Word document", &["docx"])
            .blocking_save_file();
        let Some(picked) = picked else {
            return Ok(None);
        };
        let dest = picked.into_path().map_err(|e| format!("io: {e}"))?;
        save_copy::write_copy(&held, &data_dirs, &dest, &bytes)
            .map(|p| Some(save_copy::display_path(&p)))
            .map_err(|e| format!("io: {e}"))
    })
    .await
    .map_err(|e| format!("io: {e}"))?
}

#[tauri::command]
fn export_trigger(
    store: tauri::State<'_, storage::Store>,
    download: tauri::State<'_, export::PandocDownloadState>,
    manuscript_id: String,
    format: String,
    trim: Option<String>,
    pandoc_path: Option<String>,
) -> Result<export::ExportJob, String> {
    export::trigger_export(
        &store,
        &manuscript_id,
        &format,
        trim.as_deref(),
        pandoc_path.as_deref(),
        Some(&download),
    )
    .map_err(err)
}

#[tauri::command]
fn pandoc_download_status(
    download: tauri::State<'_, export::PandocDownloadState>,
) -> export::PandocDownloadStatus {
    download.snapshot()
}

#[tauri::command]
fn export_get(
    store: tauri::State<'_, storage::Store>,
    job_id: String,
) -> Result<export::ExportJob, String> {
    store.get_export_job(&job_id).map_err(err)
}

#[tauri::command]
fn export_list(
    store: tauri::State<'_, storage::Store>,
    manuscript_id: String,
    limit: Option<usize>,
) -> Result<Vec<export::ExportJob>, String> {
    store
        .list_export_jobs(&manuscript_id, limit.unwrap_or(20))
        .map_err(err)
}

#[tauri::command]
async fn export_save_via_dialog(
    app: tauri::AppHandle,
    window: tauri::Window,
    store: tauri::State<'_, storage::Store>,
    job_id: String,
) -> Result<Option<String>, String> {
    let app = app.clone();
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let job = store.get_export_job(&job_id).map_err(err)?;
        if job.status != "succeeded" {
            return Err("Export is not ready to save yet.".into());
        }
        let path = export::delivery::save_export_via_dialog(&app, &window, &store, &job)?;
        if let Some(ref p) = path {
            store.set_export_job_user_path(&job_id, p).map_err(err)?;
        }
        Ok(path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn export_reveal_in_folder(path: String) -> Result<(), String> {
    export::delivery::reveal_in_file_manager(&path)
}

/// Recovery notices that could not be saved to disk; shown from memory until dismissed.
#[derive(Default)]
struct UnsavedNotices(std::sync::Mutex<Vec<backup::RecoveryNotice>>);

/// Notices left by startup recovery when it moved folders aside. Reading does not clear them.
#[tauri::command]
fn recovery_notices(
    store: tauri::State<'_, storage::Store>,
    unsaved: tauri::State<'_, UnsavedNotices>,
) -> Vec<backup::RecoveryNotice> {
    let mut all = backup::read_recovery_notices(store.data_dir());
    all.extend(
        unsaved
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .cloned(),
    );
    all
}

/// The user pressed Dismiss: clear the notices that were shown (by id); newer ones stay.
#[tauri::command]
fn dismiss_recovery_notices(
    store: tauri::State<'_, storage::Store>,
    unsaved: tauri::State<'_, UnsavedNotices>,
    ids: Vec<String>,
) -> Result<(), String> {
    unsaved
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|n| !ids.contains(&n.id));
    backup::dismiss_recovery_notices(store.data_dir(), &ids).map_err(|e| e.to_string())
}

/// Migration notices from this launch (#43), kept apart from restore recovery.
#[derive(Default)]
struct MigrationNotices(std::sync::Mutex<Vec<migrate::MigrationNotice>>);

/// `migration_notices` → `[{ id, kind: "info" | "warn", text }]`: plain-text notices from the
/// rename migration this launch. Separate from `recovery_notices`. Reading does not clear.
#[tauri::command]
fn migration_notices(notices: tauri::State<'_, MigrationNotices>) -> Vec<migrate::MigrationNotice> {
    notices.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// `dismiss_migration_notices({ ids })`: hide the shown migration notices for this launch.
#[tauri::command]
fn dismiss_migration_notices(notices: tauri::State<'_, MigrationNotices>, ids: Vec<String>) {
    notices
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|n| !ids.contains(&n.id));
}

/// Restore a backup. The file is chosen here in a native open dialog, never taken from the
/// webview (#83), and validated by the archive's manifest format id and contents, not its name.
/// Returns `Ok(None)` if the user cancelled. Errors are short codes for the UI
/// (`not-a-backup`, `too-new`, `busy`, `restore-failed`, `restore-incomplete`); paths and details go to the log only.
#[tauri::command]
async fn restore_backup(
    app: tauri::AppHandle,
    window: tauri::Window,
    store: tauri::State<'_, storage::Store>,
) -> Result<Option<backup::RestoreOutcome>, String> {
    use tauri_plugin_dialog::DialogExt;
    let store = store.inner().clone();
    let version = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        // One backup or restore at a time, held from before the dialog to the end (#86).
        let lock = app.state::<backup::OpLock>();
        let held = lock.try_acquire().map_err(str::to_string)?;
        let picked = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("Restore from backup")
            .add_filter(backup::RESTORE_FILTER_NAME, &["zip"])
            .blocking_pick_file();
        let Some(picked) = picked else {
            return Ok(None);
        };
        let src = picked.into_path().map_err(|e| {
            eprintln!("restore: bad dialog path: {e}");
            backup::RESTORE_FAILED.to_string()
        })?;
        backup::restore_picked(&held, &store, &version, &src)
            .map(Some)
            .map_err(str::to_string)
    })
    .await
    .map_err(|e| {
        // A panicked task may have stopped mid-swap, so don't claim the book is unchanged.
        eprintln!("restore: task failed: {e}");
        backup::RESTORE_INCOMPLETE.to_string()
    })?
}

/// Run a store call off the main thread. Sync commands run on the main thread, so a locked
/// database froze the window for every retry; async commands keep the UI responsive.
async fn blocking<T: Send + 'static>(
    store: &storage::Store,
    f: impl FnOnce(&storage::Store) -> Result<T, storage::StorageError> + Send + 'static,
) -> Result<T, String> {
    let store = store.clone();
    tauri::async_runtime::spawn_blocking(move || f(&store))
        .await
        .map_err(|e| e.to_string())?
        .map_err(err)
}

/// Persist an imported manuscript (manuscript row, sections and their initial documents) in
/// one transaction, so it is visible to the MCP server right away and survives a restart.
#[tauri::command]
async fn manuscript_import_json(
    app: tauri::AppHandle,
    store: tauri::State<'_, storage::Store>,
    title: String,
    author: Option<String>,
    sections: Vec<manuscripts::ImportSection>,
) -> Result<manuscripts::StoredManuscript, String> {
    let app = app.clone();
    blocking(&store, move |s| {
        let mut emit = move |stage: &str, percent: u8, title: &str, chapters_found: u32| {
            opening_progress::emit(&app, stage, percent, title, chapters_found);
        };
        let author_ref = author.as_deref();
        let (m, _) =
            s.import_manuscript_with_progress(&title, &sections, author_ref, Some(&mut emit))?;
        s.load_manuscript_with_progress(&m.id, Some(&mut emit))
    })
    .await
}

/// The most recently created manuscript, if any.
#[tauri::command]
async fn manuscript_open_latest(
    app: tauri::AppHandle,
    store: tauri::State<'_, storage::Store>,
) -> Result<Option<manuscripts::StoredManuscript>, String> {
    let app = app.clone();
    blocking(&store, move |s| {
        let mut emit = move |stage: &str, percent: u8, title: &str, chapters_found: u32| {
            opening_progress::emit(&app, stage, percent, title, chapters_found);
        };
        s.latest_manuscript_with_progress(Some(&mut emit))
    })
    .await
}

#[tauri::command]
async fn manuscript_create_blank(
    app: tauri::AppHandle,
    store: tauri::State<'_, storage::Store>,
) -> Result<manuscripts::StoredManuscript, String> {
    let app = app.clone();
    blocking(&store, move |s| {
        let mut emit = move |stage: &str, percent: u8, title: &str, chapters_found: u32| {
            opening_progress::emit(&app, stage, percent, title, chapters_found);
        };
        s.create_blank_manuscript_with_progress(Some(&mut emit))
    })
    .await
}

#[tauri::command]
async fn manuscript_load(
    app: tauri::AppHandle,
    store: tauri::State<'_, storage::Store>,
    manuscript_id: String,
) -> Result<manuscripts::StoredManuscript, String> {
    let app = app.clone();
    blocking(&store, move |s| {
        let mut emit = move |stage: &str, percent: u8, title: &str, chapters_found: u32| {
            opening_progress::emit(&app, stage, percent, title, chapters_found);
        };
        s.load_manuscript_with_progress(&manuscript_id, Some(&mut emit))
    })
    .await
}

/// Save the whole outline of a stored manuscript (rename, reorder, move, add, delete).
#[tauri::command]
async fn manuscript_save_outline(
    store: tauri::State<'_, storage::Store>,
    manuscript_id: String,
    outline: Vec<manuscripts::OutlineEntry>,
) -> Result<Vec<manuscripts::Section>, String> {
    blocking(&store, move |s| s.save_outline(&manuscript_id, &outline)).await
}

/// Append one editor update to a section's document.
#[tauri::command]
async fn section_apply_update(
    store: tauri::State<'_, storage::Store>,
    manuscript_id: String,
    section_id: String,
    update: Vec<u8>,
) -> Result<(), String> {
    blocking(&store, move |s| {
        s.apply_section_update(&manuscript_id, &section_id, &update)
    })
    .await
}

/// Section updates written after `after` (e.g. an agent's suggestions over MCP), so the open
/// editor can show them live (RAD-264).
#[tauri::command]
async fn manuscript_updates_since(
    store: tauri::State<'_, storage::Store>,
    manuscript_id: String,
    after: i64,
) -> Result<manuscripts::UpdatesSince, String> {
    blocking(&store, move |s| s.updates_since(&manuscript_id, after)).await
}

#[tauri::command]
async fn manuscripts_list(
    store: tauri::State<'_, storage::Store>,
) -> Result<Vec<manuscripts::Manuscript>, String> {
    blocking(&store, |s| s.list_manuscripts()).await
}

#[tauri::command]
async fn manuscript_set_numbering_style(
    store: tauri::State<'_, storage::Store>,
    manuscript_id: String,
    style: String,
) -> Result<manuscripts::Manuscript, String> {
    blocking(&store, move |s| {
        s.set_numbering_style(&manuscript_id, &style)
    })
    .await
}

#[tauri::command]
async fn notes_load(
    store: tauri::State<'_, storage::Store>,
    manuscript_id: String,
) -> Result<notes::NotesState, String> {
    blocking(&store, move |s| s.load_notes_state(&manuscript_id)).await
}

#[tauri::command]
async fn notes_apply_update(
    store: tauri::State<'_, storage::Store>,
    manuscript_id: String,
    update: Vec<u8>,
) -> Result<(), String> {
    blocking(&store, move |s| {
        s.apply_notes_update(&manuscript_id, &update)
    })
    .await
}

/// Where the MCP server is listening, or why it is not.
#[derive(Clone, serde::Serialize)]
pub struct McpStatus {
    url: Option<String>,
    error: Option<String>,
}

#[tauri::command]
fn mcp_status(status: tauri::State<'_, std::sync::Mutex<McpStatus>>) -> McpStatus {
    status.lock().expect("status poisoned").clone()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewCommentRow {
    id: String,
    thread_id: String,
    body: String,
    author_kind: String,
    author_id: String,
    author_name: String,
    created_at: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SectionReviewMeta {
    comments: Vec<ReviewCommentRow>,
    author_saved_names: std::collections::HashMap<String, String>,
    suggestion_reasons: std::collections::HashMap<String, String>,
}

fn review_comment_row(c: manuscripts::Comment) -> ReviewCommentRow {
    ReviewCommentRow {
        thread_id: c.thread_id.clone().unwrap_or_else(|| c.id.clone()),
        id: c.id,
        body: c.body,
        author_kind: c.author.kind,
        author_id: c.author.id,
        author_name: c.author.name,
        created_at: c.created_at,
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ManuscriptCommentRow {
    section_id: String,
    thread_id: String,
    body: String,
    author_name: String,
    created_at: String,
}

fn manuscript_comment_row(c: manuscripts::Comment) -> ManuscriptCommentRow {
    ManuscriptCommentRow {
        section_id: c.section_id,
        thread_id: c.thread_id.unwrap_or(c.id),
        body: c.body,
        author_name: c.author.name,
        created_at: c.created_at,
    }
}

/// Open comments for every section of a manuscript (Save a copy .docx export, #74).
#[tauri::command]
async fn manuscript_open_comments(
    store: tauri::State<'_, storage::Store>,
    manuscript_id: String,
) -> Result<Vec<ManuscriptCommentRow>, String> {
    blocking(&store, move |s| {
        Ok(s.open_comments_for_manuscript(&manuscript_id)?
            .into_iter()
            .map(manuscript_comment_row)
            .collect())
    })
    .await
}

/// Open comments and saved agent display names for the review sidebar (#47).
#[tauri::command]
async fn section_review_meta(
    store: tauri::State<'_, storage::Store>,
    section_id: String,
) -> Result<SectionReviewMeta, String> {
    blocking(&store, move |s| {
        let comments = s.open_comments(&section_id)?;
        let suggestions = s.open_suggestions(&section_id)?;
        let mut author_saved_names = std::collections::HashMap::new();
        for sug in &suggestions {
            if sug.author.kind == "agent" {
                author_saved_names
                    .insert(format!("agent:{}", sug.author.id), sug.author.name.clone());
            }
        }
        for c in &comments {
            if c.author.kind == "agent" {
                author_saved_names.insert(format!("agent:{}", c.author.id), c.author.name.clone());
            }
        }
        let mut suggestion_reasons = std::collections::HashMap::new();
        for sug in &suggestions {
            if let Some(r) = sug.rationale.as_ref().filter(|s| !s.is_empty()) {
                suggestion_reasons.insert(sug.id.clone(), r.clone());
            }
        }
        Ok(SectionReviewMeta {
            comments: comments.into_iter().map(review_comment_row).collect(),
            author_saved_names,
            suggestion_reasons,
        })
    })
    .await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ManuscriptReviewDecisions {
    by_section: std::collections::HashMap<String, Vec<manuscripts::ReviewDecisionRecord>>,
}

/// All review decision records for a manuscript (#51).
#[tauri::command]
async fn manuscript_review_decisions(
    store: tauri::State<'_, storage::Store>,
    manuscript_id: String,
) -> Result<ManuscriptReviewDecisions, String> {
    blocking(&store, move |s| {
        Ok(ManuscriptReviewDecisions {
            by_section: s.review_decisions_for_manuscript(&manuscript_id)?,
        })
    })
    .await
}

/// Replace the decision log for one section (#51).
#[tauri::command]
async fn section_save_review_decisions(
    store: tauri::State<'_, storage::Store>,
    manuscript_id: String,
    section_id: String,
    records: Vec<manuscripts::ReviewDecisionRecord>,
) -> Result<(), String> {
    blocking(&store, move |s| {
        s.save_section_review_decisions(&manuscript_id, &section_id, &records)
    })
    .await
}

/// Mark open suggestions outdated in the index after an accept (#178).
#[tauri::command]
async fn section_mark_suggestions_outdated(
    store: tauri::State<'_, storage::Store>,
    manuscript_id: String,
    section_id: String,
    suggestion_ids: Vec<String>,
    marked_by: String,
) -> Result<(), String> {
    blocking(&store, move |s| {
        let owner: String = s.with_conn(|c| {
            c.query_row(
                "SELECT manuscript_id FROM sections WHERE id = ?1",
                [&section_id],
                |r| r.get(0),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    storage::StorageError::NotFound(section_id.clone())
                }
                e => storage::StorageError::from(e),
            })
        })?;
        if owner != manuscript_id {
            return Err(storage::StorageError::Invalid(
                "section belongs to another manuscript".into(),
            ));
        }
        let at = s.now()?;
        s.mark_suggestions_outdated(&section_id, &suggestion_ids, &at, &marked_by)
    })
    .await
}

/// Clear outdated suggestion index rows after dismiss (#179).
#[tauri::command]
async fn section_dismiss_outdated_suggestions(
    store: tauri::State<'_, storage::Store>,
    manuscript_id: String,
    section_id: String,
    suggestion_ids: Vec<String>,
) -> Result<(), String> {
    blocking(&store, move |s| {
        let owner: String = s.with_conn(|c| {
            c.query_row(
                "SELECT manuscript_id FROM sections WHERE id = ?1",
                [&section_id],
                |r| r.get(0),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    storage::StorageError::NotFound(section_id.clone())
                }
                e => storage::StorageError::from(e),
            })
        })?;
        if owner != manuscript_id {
            return Err(storage::StorageError::Invalid(
                "section belongs to another manuscript".into(),
            ));
        }
        s.dismiss_outdated_suggestions(&section_id, &suggestion_ids)
    })
    .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Some(icon) = app.default_window_icon().cloned() {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(e) = window.set_icon(icon) {
                        eprintln!("Main window icon not set: {e}");
                    }
                }
            }
            let dir = app.path().app_data_dir()?;
            // #43: copy (never move) the pre-rename data folder before anything opens it.
            // Only the roaming folder: the local one holds just the WebView2 cache.
            let mut migration_notices = migrate::startup_migration(&dir);
            let report = backup::cleanup_temp(&dir);
            // #43: both apps default to the same MCP port; if an old coAuthor holds it, say so
            // at startup instead of letting agents keep writing into the old data.
            let listener = match mcp::bind(mcp::DEFAULT_PORT) {
                Ok(l) => Ok(l),
                Err(e) => {
                    eprintln!("MCP server not started: {e}");
                    if e.kind() == std::io::ErrorKind::AddrInUse {
                        migration_notices.push(migrate::MigrationNotice::new(
                            migrate::NoticeKind::Warn,
                            &mcp::port_in_use_user_message(mcp::DEFAULT_PORT),
                        ));
                    }
                    Err(e.to_string())
                }
            };
            app.manage(MigrationNotices(std::sync::Mutex::new(migration_notices)));
            app.manage(UnsavedNotices(std::sync::Mutex::new(
                report.unsaved_notices,
            )));
            let store = storage::Store::open(&dir)?;
            app.manage(store.clone());
            app.manage(export::PandocDownloadState::default());
            app.manage(backup::OpLock::default());
            app.manage(std::sync::Mutex::new(McpStatus {
                url: None,
                error: listener.as_ref().err().cloned(),
            }));
            // The MCP server shares the store. If the port is taken, the app still runs, the
            // startup notice explains it, and mcp_status reports the error.
            let handle = app.handle().clone();
            let Ok(listener) = listener else {
                return Ok(());
            };
            tauri::async_runtime::spawn(async move {
                let emit_handle = handle.clone();
                let hook: mcp::PairingRequestedHook = Arc::new(move |pairing_id: String| {
                    let _ = emit_handle.emit(
                        "pairing-requested",
                        serde_json::json!({ "pairingId": pairing_id }),
                    );
                });
                let result = mcp::serve_on(store, listener, Some(hook)).await;
                let state = handle.state::<std::sync::Mutex<McpStatus>>();
                let mut st = state.lock().expect("status poisoned");
                match result {
                    Ok(addr) => st.url = Some(format!("http://{addr}/mcp")),
                    Err(e) => {
                        eprintln!("MCP server not started: {e}");
                        st.error = Some(e.to_string());
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            agents_list,
            agents_primary_id,
            agent_create,
            set_user_display_name,
            agent_revoke,
            agent_tokens_list,
            agent_token_create,
            agent_token_revoke,
            list_pending_pairings,
            approve_pairing,
            deny_pairing,
            agents_draft_access_list,
            agent_set_draft_access_mode,
            agent_grant_draft,
            agent_revoke_draft,
            agents_bulk_grant_current_draft,
            agents_bulk_grant_all_drafts,
            agents_bulk_revoke_all_drafts,
            create_backup,
            recovery_notices,
            dismiss_recovery_notices,
            migration_notices,
            dismiss_migration_notices,
            restore_backup,
            manuscript_import_json,
            manuscripts_list,
            manuscript_open_latest,
            manuscript_create_blank,
            manuscript_load,
            section_apply_update,
            manuscript_save_outline,
            manuscript_updates_since,
            manuscript_set_numbering_style,
            notes_load,
            notes_apply_update,
            section_review_meta,
            manuscript_review_decisions,
            section_save_review_decisions,
            section_mark_suggestions_outdated,
            section_dismiss_outdated_suggestions,
            manuscript_open_comments,
            spell_lint_paragraph,
            spell_dictionary_list,
            spell_dictionary_add,
            spell_dictionary_remove,
            spell_dictionary_ignore,
            mcp_status,
            save_manuscript_copy,
            export_trigger,
            pandoc_download_status,
            export_get,
            export_list,
            export_save_via_dialog,
            export_reveal_in_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running swarmDraft");
}

#[cfg(test)]
mod tests {
    use super::os_user_display_name;

    #[test]
    fn os_user_display_name_trims_username_env() {
        let saved = std::env::var("USERNAME").ok();
        std::env::set_var("USERNAME", "  Pat  ");
        assert_eq!(os_user_display_name(), "Pat");
        if let Some(v) = saved {
            std::env::set_var("USERNAME", v);
        } else {
            std::env::remove_var("USERNAME");
        }
    }
}
