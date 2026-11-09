# Installing the swarmDraft dev build on macOS

The macOS builds are **unsigned**. Apple signing and notarization are deferred until an Apple
Developer membership is approved. Windows stays first; see [install-windows.md](./install-windows.md).

1. Open **[Releases](https://github.com/southline-tech/swarmDraft/releases)** and pick the newest
   `vX.Y.Z`. Download the unsigned disk image `swarmDraft_<version>_universal.dmg` (Apple silicon
   and Intel in one file). If a universal image is not attached, download the file that matches
   your Mac: `…_aarch64.dmg` (Apple silicon) or `…_x64.dmg` (Intel). Optionally verify the file
   against `SHA256SUMS-macos.txt` on that release.

2. Open the `.dmg` and drag **swarmDraft** to **Applications**.

3. Gatekeeper will warn because the app is not signed or notarized. macOS may say
   **"swarmDraft" can't be opened because Apple cannot check it for malicious software**.

   To open it anyway:

   - In Finder, open **Applications**.
   - **Control-click** (or right-click) **swarmDraft** and choose **Open**.
   - In the dialog, choose **Open**.
   - If macOS only offers **Move to Trash** or **Done**, open **System Settings → Privacy & Security**,
     find the swarmDraft message, and click **Open Anyway**. Confirm **Open Anyway**.

   You only need this extra step the first time you open an unsigned build.

4. Your books and settings stay on this Mac in
   `~/Library/Application Support/com.radiancelux.swarmdraft/`. Export files are in the `exports`
   folder there. Dragging the app to the Trash does not delete that folder.

Opening a `.draft` file from Finder launches swarmDraft and opens that book.

The local agent connection listens on `127.0.0.1` only (default port 7337). A paired bot keeps its
key in `~/swarmdraft-bot/key.txt` (the same folder name Windows uses under the user profile).
