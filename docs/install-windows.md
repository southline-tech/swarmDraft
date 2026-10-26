# Installing the coAuthor dev build on Windows

The P1 builds are **unsigned**. Code signing is deferred until a certificate is approved.

1. Open the latest successful **CI** run on `main` (Actions tab) and download the
   `coauthor-windows-unsigned-<sha>` artifact. Unzip it.
2. The zip contains two subfolders; run either installer:
   - `msi/coAuthor_<version>_x64_en-US.msi` (MSI), or
   - `nsis/coAuthor_<version>_x64-setup.exe` (NSIS).
3. Windows SmartScreen will show **"Windows protected your PC"** / unknown publisher, because the
   build is unsigned. Click **More info** then **Run anyway**.
4. If WebView2 is missing (rare on Windows 10/11), the installer downloads it.

Data is stored locally in `%APPDATA%\com.radiancelux.coauthor\` (`coauthor.db`, SQLite).
Uninstall from Settings > Apps; the data folder is kept unless deleted by hand.

The local MCP server listens on `127.0.0.1` only (default port 7337); agent tokens are managed in
the app (RAD-205/209).

## Installer pages (issue #61)

The NSIS installer installs **per user** (`installMode: currentUser`): no admin prompt, files go to
`%LOCALAPPDATA%\coAuthor`. Page copy and art follow mockups ob1 to ob3 and live in
`apps/desktop/src-tauri/windows/` (`installer-pages.nsh`, `nsis-sidebar.bmp`, `nsis-header.bmp`).
The `.nsh` is a Tauri installer hook that sets MUI page text; the stock Tauri template is not forked.

Known gaps versus the mockups (limits of classic NSIS/MUI2 dialogs):

- Fixed Win32 dialog size and system font; no rounded buttons, accent colours or large type.
- Button labels are the stock "Next >" / "Finish" (the mockup's "Install" would need a custom template).
- The stock "Choose Install Location" page still shows between welcome and progress.
- The progress bar is the native one; no "About 30 seconds left" estimate.
- The finish page also shows the stock "Create desktop shortcut" checkbox.
- Not yet verified on a real Windows build.

## Uninstalling

Uninstall coAuthor from Windows Settings > Apps, or from its Start menu entry. The uninstaller shows a **Delete the application data** checkbox. It is unchecked by default, so your manuscripts, settings and agent tokens stay on your computer unless you tick it. Tick it only if you want everything coAuthor stored removed.
