# In-app updater signing (#310)

The desktop app checks GitHub Releases for `latest.json` and installs signed updates with the author's OK.

## One-time setup (Brett)

1. Generate a keypair (keep the private key secret):

   ```sh
   pnpm --dir apps/desktop tauri signer generate -w ~/.tauri/swarmdraft-updater.key
   ```

2. Add GitHub repository secrets (Settings → Secrets and variables → Actions):

   - `TAURI_SIGNING_PRIVATE_KEY` — contents of the **private** key file.
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — key password, if any.

3. The **public** key must match `plugins.updater.pubkey` in `apps/desktop/src-tauri/tauri.conf.json` (safe to commit). Source of truth: `~/.tauri/swarmdraft-updater.key.pub` or the **Signing key (done)** section in `prompts-2026-11-04-310-updater.md`. Sync from either path:

   ```sh
   node scripts/sync-updater-pubkey.mjs
   ```

   Or set `SWARMDRAFT_UPDATER_PUBKEY_FILE=/path/to/swarmdraft-updater.key.pub` when the default paths are elsewhere.

4. Back up the private key offline. If it is lost, existing installs cannot verify future updates.

## Release workflow

On `v*` tags, `.github/workflows/release.yml` builds NSIS + MSI with `createUpdaterArtifacts`, signs bundles using the secrets above, publishes a GitHub Release, uploads `.sig` files, and generates `latest.json` (`uploadUpdaterJson: true`, NSIS preferred).

## End-to-end test (after secrets are set)

1. Tag and push an older version, install that build on Windows.
2. Bump version on `main`, tag the new version, wait for Release workflow.
3. Launch the old build; after ~5 seconds (or **Check for updates…** in the book menu) choose **Update now**.
4. Confirm the app relaunches on the new version and manuscripts in `%APPDATA%\com.radiancelux.swarmdraft\` are intact.

Do not push tags from a PR branch.
