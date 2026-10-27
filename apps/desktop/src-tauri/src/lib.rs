//! coAuthor desktop backend.
//!
//! Module ownership:
//! - `storage`: local data directory and SQLite (manuscript metadata, Yjs updates, backups).
//! - `backup`: full-project .zip backup and validated restore (RAD-224).
//! - `agents`: agent principals and hashed per-agent bearer tokens (RAD-205).
//! - `mcp`: in-app MCP server bound to 127.0.0.1 with per-agent bearer tokens (RAD-205/209/210).

pub mod agents;
pub mod anchor;
pub mod backup;
pub mod content;
pub mod manuscripts;
pub mod mcp;
pub mod save_copy;
pub mod storage;

use serde::Serialize;
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    data_dir: String,
    schema_version: i64,
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
fn agent_create(
    store: tauri::State<'_, storage::Store>,
    name: String,
    color: String,
) -> Result<agents::Agent, String> {
    store.create_agent(&name, &color).map_err(err)
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
/// written atomically. Returns the path written, or `None` if the user cancelled.
#[tauri::command]
async fn save_manuscript_copy(
    app: tauri::AppHandle,
    store: tauri::State<'_, storage::Store>,
    title: String,
    bytes: Vec<u8>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let mut data_dirs = vec![store.data_dir().to_path_buf()];
    data_dirs.extend(app.path().app_data_dir().ok());
    data_dirs.extend(app.path().app_local_data_dir().ok());
    tauri::async_runtime::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .set_title("Save a copy")
            .set_file_name(save_copy::default_file_name(&title))
            .add_filter("Word document", &["docx"])
            .blocking_save_file();
        let Some(picked) = picked else {
            return Ok(None);
        };
        let dest = picked.into_path().map_err(|e| format!("io: {e}"))?;
        save_copy::write_copy(&data_dirs, &dest, &bytes)
            .map(|p| Some(p.display().to_string()))
            .map_err(|e| format!("io: {e}"))
    })
    .await
    .map_err(|e| format!("io: {e}"))?
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
    store: tauri::State<'_, storage::Store>,
    title: String,
    sections: Vec<manuscripts::ImportSection>,
) -> Result<manuscripts::StoredManuscript, String> {
    blocking(&store, move |s| {
        let (m, _) = s.import_manuscript(&title, &sections)?;
        s.load_manuscript(&m.id)
    })
    .await
}

/// The most recently created manuscript, if any.
#[tauri::command]
async fn manuscript_open_latest(
    store: tauri::State<'_, storage::Store>,
) -> Result<Option<manuscripts::StoredManuscript>, String> {
    blocking(&store, |s| s.latest_manuscript()).await
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let report = backup::cleanup_temp(&dir);
            app.manage(UnsavedNotices(std::sync::Mutex::new(
                report.unsaved_notices,
            )));
            let store = storage::Store::open(&dir)?;
            app.manage(store.clone());
            app.manage(backup::OpLock::default());
            app.manage(std::sync::Mutex::new(McpStatus {
                url: None,
                error: None,
            }));
            // The MCP server shares the store. If the port is taken, the app still runs and
            // the settings screen shows the error.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let result = mcp::serve(store, mcp::DEFAULT_PORT).await;
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
            agent_create,
            agent_revoke,
            agent_tokens_list,
            agent_token_create,
            agent_token_revoke,
            create_backup,
            recovery_notices,
            dismiss_recovery_notices,
            restore_backup,
            manuscript_import_json,
            manuscripts_list,
            manuscript_open_latest,
            section_apply_update,
            manuscript_save_outline,
            manuscript_updates_since,
            mcp_status,
            save_manuscript_copy
        ])
        .run(tauri::generate_context!())
        .expect("error while running coAuthor");
}
