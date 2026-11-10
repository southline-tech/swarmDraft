//! Native macOS menu bar (#193).
//!
//! Edit is required so copy, paste, and the other clipboard commands reach the webview.
//! Undo and redo stay off this menu so Command-Z stays on the editor history.
//! Quit is a custom item: the predefined Quit item calls `terminate:` and skips the save flush.
//! Windows and Linux keep the in-app book menu only; this module does not call `set_menu` there.

use tauri::Emitter;

/// Application menu, then File, Edit, and Window. The first title is the fallback when
/// `productName` is empty; the installed app menu uses the configured product name.
pub const MACOS_MENU_TITLES: &[&str] = &["swarmDraft", "File", "Edit", "Window"];

/// Id of the custom Quit item. Not `PredefinedMenuItem::quit` (`terminate:` / Cmd+Q).
pub const QUIT_MENU_ID: &str = "macos-quit";

/// Event emitted when that item (or its Command-Q equivalent) is chosen.
/// The frontend handles it with the same flush-then-destroy path as the book menu.
pub const QUIT_EVENT: &str = "macos-quit";

/// Menu accelerator. `CmdOrCtrl` is Command on macOS.
pub const QUIT_ACCELERATOR: &str = "CmdOrCtrl+Q";

pub const APP_MENU_ACTIONS: &[&str] = &[
    "about",
    "separator",
    "services",
    "separator",
    "hide",
    "hide_others",
    "separator",
    "quit_flush",
];

pub const FILE_MENU_ACTIONS: &[&str] = &["close_window"];

/// Clipboard commands only. Undo and redo would bind `undo:` / `redo:` and steal Command-Z
/// from the editor history (#193 review).
pub const EDIT_MENU_ACTIONS: &[&str] = &["cut", "copy", "paste", "select_all"];

pub const WINDOW_MENU_ACTIONS: &[&str] = &["minimize", "maximize", "separator", "close_window"];

/// Native selectors that must not be installed. `quit` is `terminate:`; `undo` / `redo`
/// bypass the editor history.
pub fn blocked_native_selector(action: &str) -> Option<&'static str> {
    match action {
        "quit" => Some("terminate:"),
        "undo" => Some("undo:"),
        "redo" => Some("redo:"),
        _ => None,
    }
}

/// Window is the only submenu AppKit treats as the windows menu, and only when its id is
/// [`tauri::menu::WINDOW_SUBMENU_ID`].
pub fn submenu_id(actions: &[&str]) -> Option<&'static str> {
    if actions.contains(&"minimize") {
        Some(tauri::menu::WINDOW_SUBMENU_ID)
    } else {
        None
    }
}

/// "Quit swarmDraft". `&` is a mnemonic marker, so a literal ampersand is doubled.
pub fn quit_menu_label(app_title: &str) -> String {
    format!("Quit {}", app_title.replace('&', "&&"))
}

/// Install the macOS menu bar. No-op on Windows and Linux.
/// The Quit listener is registered everywhere so a later menu event still flushes;
/// only macOS installs the item that emits it.
pub fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    install_macos(app)?;
    app.on_menu_event(|handle, event| {
        if event.id() == QUIT_MENU_ID {
            let _ = handle.emit(QUIT_EVENT, ());
        }
    });
    Ok(())
}

#[cfg(target_os = "macos")]
fn install_macos(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{AboutMetadata, Menu};

    let title = app
        .config()
        .product_name
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| MACOS_MENU_TITLES[0].to_string());
    let pkg = app.package_info();
    let about = AboutMetadata {
        name: Some(title.clone()),
        version: Some(pkg.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        authors: app.config().bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };
    let app_menu = submenu_from(app, &title, APP_MENU_ACTIONS, &title, &about)?;
    let file_menu = submenu_from(app, MACOS_MENU_TITLES[1], FILE_MENU_ACTIONS, &title, &about)?;
    let edit_menu = submenu_from(app, MACOS_MENU_TITLES[2], EDIT_MENU_ACTIONS, &title, &about)?;
    let window_menu = submenu_from(
        app,
        MACOS_MENU_TITLES[3],
        WINDOW_MENU_ACTIONS,
        &title,
        &about,
    )?;
    let menu = Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &window_menu])?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg(target_os = "macos")]
enum BuiltItem {
    Predefined(tauri::menu::PredefinedMenuItem<tauri::Wry>),
    Custom(tauri::menu::MenuItem<tauri::Wry>),
}

#[cfg(target_os = "macos")]
impl BuiltItem {
    fn as_item(&self) -> &dyn tauri::menu::IsMenuItem<tauri::Wry> {
        match self {
            Self::Predefined(item) => item,
            Self::Custom(item) => item,
        }
    }
}

#[cfg(target_os = "macos")]
fn submenu_from(
    app: &tauri::AppHandle,
    title: &str,
    actions: &[&str],
    app_title: &str,
    about: &tauri::menu::AboutMetadata<'_>,
) -> tauri::Result<tauri::menu::Submenu<tauri::Wry>> {
    let mut owned = Vec::with_capacity(actions.len());
    for action in actions {
        owned.push(build_item(app, action, app_title, about)?);
    }
    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        owned.iter().map(BuiltItem::as_item).collect();
    if let Some(id) = submenu_id(actions) {
        tauri::menu::Submenu::with_id_and_items(app, id, title, true, &refs)
    } else {
        tauri::menu::Submenu::with_items(app, title, true, &refs)
    }
}

#[cfg(target_os = "macos")]
fn build_item(
    app: &tauri::AppHandle,
    action: &str,
    app_title: &str,
    about: &tauri::menu::AboutMetadata<'_>,
) -> tauri::Result<BuiltItem> {
    if blocked_native_selector(action).is_some() {
        unreachable!("macOS menu action {action} bypasses the editor");
    }
    if action == "quit_flush" {
        return Ok(BuiltItem::Custom(tauri::menu::MenuItem::with_id(
            app,
            QUIT_MENU_ID,
            quit_menu_label(app_title),
            true,
            Some(QUIT_ACCELERATOR),
        )?));
    }
    Ok(BuiltItem::Predefined(predefined(app, action, about)?))
}

#[cfg(target_os = "macos")]
fn predefined(
    app: &tauri::AppHandle,
    action: &str,
    about: &tauri::menu::AboutMetadata<'_>,
) -> tauri::Result<tauri::menu::PredefinedMenuItem<tauri::Wry>> {
    use tauri::menu::PredefinedMenuItem;
    match action {
        "about" => PredefinedMenuItem::about(app, None, Some(about.clone())),
        "separator" => PredefinedMenuItem::separator(app),
        "services" => PredefinedMenuItem::services(app, None),
        "hide" => PredefinedMenuItem::hide(app, None),
        "hide_others" => PredefinedMenuItem::hide_others(app, None),
        "close_window" => PredefinedMenuItem::close_window(app, None),
        "cut" => PredefinedMenuItem::cut(app, None),
        "copy" => PredefinedMenuItem::copy(app, None),
        "paste" => PredefinedMenuItem::paste(app, None),
        "select_all" => PredefinedMenuItem::select_all(app, None),
        "minimize" => PredefinedMenuItem::minimize(app, None),
        "maximize" => PredefinedMenuItem::maximize(app, None),
        other => unreachable!("unknown macOS menu action {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_menu_bar_is_app_file_edit_window() {
        assert_eq!(MACOS_MENU_TITLES, ["swarmDraft", "File", "Edit", "Window"]);
        assert!(FILE_MENU_ACTIONS.contains(&"close_window"));
        assert!(WINDOW_MENU_ACTIONS.contains(&"minimize"));
    }

    #[test]
    fn macos_edit_menu_keeps_clipboard_and_leaves_history() {
        for action in ["cut", "copy", "paste", "select_all"] {
            assert!(EDIT_MENU_ACTIONS.contains(&action), "{action}");
        }
        assert!(!EDIT_MENU_ACTIONS.contains(&"undo"));
        assert!(!EDIT_MENU_ACTIONS.contains(&"redo"));
    }

    #[test]
    fn macos_quit_flushes_instead_of_terminate() {
        assert!(APP_MENU_ACTIONS.contains(&"quit_flush"));
        assert!(!APP_MENU_ACTIONS.contains(&"quit"));
        assert_eq!(blocked_native_selector("quit"), Some("terminate:"));
        assert_eq!(blocked_native_selector("undo"), Some("undo:"));
        assert_eq!(blocked_native_selector("redo"), Some("redo:"));
        assert_eq!(QUIT_MENU_ID, QUIT_EVENT);
        assert_eq!(QUIT_ACCELERATOR, "CmdOrCtrl+Q");
        assert_eq!(quit_menu_label("swarmDraft"), "Quit swarmDraft");
        for action in APP_MENU_ACTIONS
            .iter()
            .chain(FILE_MENU_ACTIONS)
            .chain(EDIT_MENU_ACTIONS)
            .chain(WINDOW_MENU_ACTIONS)
        {
            assert!(
                blocked_native_selector(action).is_none(),
                "{action} would bypass the editor"
            );
        }
    }

    #[test]
    fn macos_window_menu_uses_tauri_window_submenu_id() {
        assert_eq!(
            submenu_id(WINDOW_MENU_ACTIONS),
            Some(tauri::menu::WINDOW_SUBMENU_ID)
        );
        assert_eq!(submenu_id(APP_MENU_ACTIONS), None);
        assert_eq!(submenu_id(FILE_MENU_ACTIONS), None);
        assert_eq!(submenu_id(EDIT_MENU_ACTIONS), None);
    }
}
