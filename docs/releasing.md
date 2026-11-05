# Releasing swarmDraft (Windows installer + in-app updater)

**Authenticode / SmartScreen signing:** still deferred ([#196](https://github.com/southline-tech/swarmDraft/issues/196)). **Updater signing** uses Tauri minisign keys — see [updater-signing.md](./updater-signing.md).

## Version bump (before the release PR)

```sh
pnpm version:set X.Y.Z
pnpm version:check
```

Commit the four version files (and `Cargo.lock` if it changed). Open a PR; CI runs `version:check`
on Linux only.

## First release after merge

1. Merge the release-workflow PR (`Refs #196`).
2. Tag the merged commit (first shipping tag is **`v0.1.0`** while versions stay at `0.1.0`):

   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```

3. Watch **Release** workflow (`.github/workflows/release.yml`) on the tag. It builds signed
   updater artifacts (NSIS + MSI) on `windows-latest`, publishes a GitHub Release with
   `latest.json`, `.sig` files, and `SHA256SUMS.txt`. Requires `TAURI_SIGNING_PRIVATE_KEY*`
   secrets — see [updater-signing.md](./updater-signing.md).
4. On a Windows test machine, install from the Release (`swarmDraft_<version>_x64-setup.exe`) and
   run [new-draft-checklist.md](./qa/new-draft-checklist.md) (New / import / switch / resume) before
   broader smoke-test and sharing with authors.
5. Share [install-kim.md](./install-kim.md) for download → SmartScreen → Install → update → data.

Do **not** push a tag from a PR branch. Tags must match `pnpm version:check --tag vX.Y.Z`.

## Out of scope on this track

- Authenticode signing (SmartScreen)
- Pandoc bundling ([#186](https://github.com/southline-tech/swarmDraft/issues/186))
- Arm-A-Rillo sign-off beyond [new-draft-checklist.md](./qa/new-draft-checklist.md)
