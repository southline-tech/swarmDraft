//! coAuthor desktop backend.
//!
//! Module ownership:
//! - `storage`: local data directory and SQLite (manuscript metadata, Yjs updates, backups).
//! - `backup`: full-project .zip backup and validated restore (RAD-224).
//! - `agents`: agent principals and hashed per-agent bearer tokens (RAD-205).
//! - `mcp`: in-app MCP server bound to 127.0.0.1 with per-agent bearer tokens (RAD-205/209/210).

pub mod agents;
pub mod backup;
pub mod mcp;
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

/// One-time notice left by startup recovery when it moved uncertain folders aside.
#[tauri::command]
fn take_recovery_notice(store: tauri::State<'_, storage::Store>) -> Option<backup::RecoveryNotice> {
    backup::take_recovery_notice(store.data_dir())
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            backup::cleanup_temp(&dir);
            let store = storage::Store::open(&dir)?;
            app.manage(store);
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
            take_recovery_notice,
            restore_backup
        ])
        .run(tauri::generate_context!())
        .expect("error while running coAuthor");
}
