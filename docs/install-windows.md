# Installing the swarmDraft dev build on Windows

The P1 builds are **unsigned**. Code signing is deferred until a certificate is approved.

1. Open the latest successful **CI** run on `main` (Actions tab) and download the
   `coauthor-windows-unsigned-<sha>` artifact. Unzip it.
2. The zip contains two subfolders; run either installer:
   - `msi/swarmDraft_<version>_x64_en-US.msi` (MSI), or
   - `nsis/swarmDraft_<version>_x64-setup.exe` (NSIS).

   The app installs as `swarmdraft.exe`.

3. Windows SmartScreen will show **"Windows protected your PC"** / unknown publisher, because the
   build is unsigned. Click **More info** then **Run anyway**.
4. If WebView2 is missing (rare on Windows 10/11), the installer downloads it.

Data is stored locally in `%APPDATA%\com.radiancelux.swarmdraft\` (`coauthor.db`, SQLite; the
file name is kept on purpose so backups and older builds stay compatible). Uninstalling keeps it
unless you tick **Also delete my manuscripts and settings** in the uninstaller (see
[Uninstalling](#uninstalling)).

### Moving from coAuthor (rename, issues #43 and #68)

The app used to be called coAuthor (identifier `com.radiancelux.coauthor`). Data folders, old to
new:

| Old                                        | New                                          |
| ------------------------------------------ | -------------------------------------------- |
| `%APPDATA%\com.radiancelux.coauthor\`      | `%APPDATA%\com.radiancelux.swarmdraft\`      |
| `%LOCALAPPDATA%\com.radiancelux.coauthor\` | `%LOCALAPPDATA%\com.radiancelux.swarmdraft\` |
| `%LOCALAPPDATA%\coAuthor\` (program files) | `%LOCALAPPDATA%\swarmDraft\`                 |

On first start, for each of the two folders: if the new folder isn't marked as migrated yet and the
old one exists, swarmDraft **copies** the old folder to the new location (through a temporary folder,
so an interrupted copy never leaves a half-filled one). The database is copied as a consistent
snapshot, so it is safe even if coAuthor is still open. A marker file (`.swarmdraft-migrated`) is
written last. The old folder is never changed or deleted, so you can go back to an older build.

If the copy fails (for example coAuthor holds its database locked), the app shows a notice asking you
to close coAuthor and starts empty; the next start retries. The empty folder from that start is kept
aside as `com.radiancelux.swarmdraft.before-migration-<time>`, not deleted. A new folder that already
holds documents is never replaced. After a successful copy the two folders are independent.

Both apps use MCP port 7337. If coAuthor is running when swarmDraft starts, swarmDraft doesn't start
its MCP server and shows a notice to close coAuthor and restart swarmDraft, so agents never write into
the old data by mistake.

An existing coAuthor install is not removed by the swarmDraft installer (it is a different product
to Windows), so both can sit side by side. Uninstall **coAuthor** from Settings > Apps when you no
longer need it; ticking its delete box removes only the old `com.radiancelux.coauthor` folders.

The local MCP server listens on `127.0.0.1` only (default port 7337); agent tokens are managed in
the app (RAD-205/209).

## Installer pages (issue #61)

The NSIS installer installs **per user** (`installMode: currentUser`): no admin prompt, files go to
`%LOCALAPPDATA%\swarmDraft`. Pages follow mockups ob1 to ob3. Everything lives in
`apps/desktop/src-tauri/windows/`:

- `installer.nsi`: custom template (`bundle.windows.nsis.template`), a copy of Tauri's default
  template for tauri-cli 2.12.4. Changes are marked `swarmDraft:`. All three pages are full-window
  with the light `--ct-*` colours. Titles use Literata (bundled, see below), falling back to
  Segoe UI Variable / Segoe UI if the font can't be loaded; body text is Segoe UI. Cancel sits on
  the left and the primary button (**Install**, **Finish**) on the right; Back is hidden.
  - Welcome (ob1): Ribbon tile, title, lead line, **Install**. There is no install location page
    for per-user installs.
  - Progress (ob2): Ribbon tile, "Installing swarmDraft…", the ob2 line and one accent progress bar.
    Only Cancel shows. No file log or output-folder text. It moves to the finish page by itself
    when the install ends.
  - Finish (ob3): check tile, "swarmDraft is ready", **Open swarmDraft now** (ticked) and **Finish**.
    The desktop shortcut is always created; there is no checkbox for it.
  - Already installed (running the installer again): Ribbon tile, "swarmDraft is already
    installed" (or "Update swarmDraft" / "A newer swarmDraft is installed"), two choices and
    **Continue**. Back is hidden.
  - Uninstall confirm, progress and finish use the same layout: "Uninstall swarmDraft?" with the
    delete checkbox and **Uninstall**; "Removing swarmDraft…" with one progress bar; check tile,
    "swarmDraft was removed" and **Finish**. Passive and update uninstalls skip the confirm and
    finish pages.
- `installer-pages.nsh`: installer hook; only tells the template where the page art is.
- `ob-logo.bmp`, `ob-check.bmp`, `nsis-header.bmp`, `nsis-sidebar.bmp`: page art. `ob-logo.bmp`,
  the header, sidebar and app icons are generated by `icons/source/generate.py`.
- `fonts/Literata-Regular.ttf`: title font, loaded privately for the installer process only
  (not installed on the system). SIL Open Font License 1.1, text in `fonts/Literata-OFL.txt`.

Passive (`/P`), silent (`/S`) and update (`/UPDATE`) installs skip the welcome and finish pages as
before. Passive and silent installs always create the desktop shortcut too; updates and `/NS`
leave shortcuts alone. When the Tauri CLI is upgraded, diff its `installer.nsi` against ours and
carry the changes over.

Known gaps versus the mockups (limits of Win32 dialogs):

- Native buttons: not rounded and not accent-filled. NSIS's main window doesn't support owner-drawn
  buttons, and bitmap buttons don't scale with DPI, so the primary button stays a standard button.
- No "About N seconds left" on the progress page: NSIS has no reliable time estimate, so there is
  no time text rather than a wrong one.
- The © line is hidden on the installer pages. The exe's file properties still carry
  "© 2026 Radiance Lux Technologies LLC". The Windows title bar is native.
- Checked by compiling with `makensis -WX` on Linux against Tauri's real include files and plugin,
  and by running the installer (interactive, `/P`, `/S`) under Wine. Not yet run on Windows.

## Uninstalling

Uninstall swarmDraft from **Settings > Apps > Installed apps > swarmDraft > Uninstall**.

The uninstaller shows an **Also delete my manuscripts and settings** checkbox, unchecked by default.

- Unticked: everything swarmDraft stored stays on your computer (manuscripts, settings, agent tokens).
- Ticked: it also deletes both `com.radiancelux.swarmdraft` folders,
  `%APPDATA%\com.radiancelux.swarmdraft\` (roaming, including `coauthor.db`) and
  `%LOCALAPPDATA%\com.radiancelux.swarmdraft\` (local). This cannot be undone. The old
  `com.radiancelux.coauthor` folders are left alone.
