//! swarmDraft desktop backend.
//!
//! Module ownership:
//! - `storage`: local data directory and SQLite (manuscript metadata, Yjs updates, backups).
//! - `backup`: full-project .zip backup and validated restore (RAD-224).
//! - `agents`: agent principals and hashed per-agent bearer tokens (RAD-205).
//! - `migrate`: first-run copy of the pre-rename data folders (#43).
//! - `mcp`: in-app MCP server bound to 127.0.0.1 with per-agent bearer tokens (RAD-205/209/210).

pub mod agents;
pub mod anchor;
pub mod backup;
pub mod content;
pub mod manuscripts;
pub mod mcp;
pub mod migrate;
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

/// Write a full backup to `dest` (from the save dialog; `replace` = user confirmed Replace,
/// which atomically replaces an existing file) or, if omitted,
/// to `<data dir>/backups/`, and return its path.
#[tauri::command]
fn create_backup(
    app: tauri::AppHandle,
    store: tauri::State<'_, storage::Store>,
    dest: Option<String>,
    replace: Option<bool>,
) -> Result<String, String> {
    let replace = replace.unwrap_or(false) && dest.is_some();
    let dest = dest
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| backup::default_backup_path(&store));
    backup::create_backup_to(
        &store,
        &app.package_info().version.to_string(),
        &dest,
        replace,
    )
    .map_err(|e| e.to_string())?;
    Ok(dest.display().to_string())
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

/// Validate and restore a backup .zip; the replaced state is kept as a pre-restore snapshot.
#[tauri::command]
fn restore_backup(
    app: tauri::AppHandle,
    store: tauri::State<'_, storage::Store>,
    path: String,
) -> Result<backup::RestoreReport, String> {
    backup::restore_backup(
        &store,
        &app.package_info().version.to_string(),
        std::path::Path::new(&path),
    )
    .map_err(|e| e.to_string())
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
            // #43: copy (never move) the pre-rename data folders before anything opens them.
            let mut migration_notices = Vec::new();
            for new_dir in [Some(dir.clone()), app.path().app_local_data_dir().ok()]
                .into_iter()
                .flatten()
            {
                let Some(old_dir) = migrate::old_dir_for(&new_dir) else {
                    continue;
                };
                if let Err(e) = migrate::migrate(&old_dir, &new_dir) {
                    eprintln!("swarmDraft: could not copy {}: {e}", old_dir.display());
                    let text = if e.kind() == std::io::ErrorKind::WouldBlock {
                        e.to_string()
                    } else {
                        format!(
                            "swarmDraft couldn't copy your earlier documents ({e}). The originals are untouched in {}.",
                            old_dir.display()
                        )
                    };
                    migration_notices.push(backup::startup_notice(&dir, text));
                }
            }
            let mut report = backup::cleanup_temp(&dir);
            report.unsaved_notices.extend(migration_notices);
            // #43: both apps default to the same MCP port; if an old coAuthor holds it, say so
            // at startup instead of letting agents keep writing into the old data.
            let listener = match mcp::bind(mcp::DEFAULT_PORT) {
                Ok(l) => Ok(l),
                Err(e) => {
                    eprintln!("MCP server not started: {e}");
                    if e.kind() == std::io::ErrorKind::AddrInUse {
                        report
                            .unsaved_notices
                            .push(backup::startup_notice(&dir, e.to_string()));
                    }
                    Err(e.to_string())
                }
            };
            app.manage(UnsavedNotices(std::sync::Mutex::new(
                report.unsaved_notices,
            )));
            let store = storage::Store::open(&dir)?;
            app.manage(store.clone());
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
                let result = mcp::serve_on(store, listener).await;
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
            mcp_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running swarmDraft");
}
