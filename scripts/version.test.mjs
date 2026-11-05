import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readVersions, setVersion, tagMatchesVersion, versionsMatch } from './version-files.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function makeTempTree(initialVersion = '0.1.0') {
  const dir = mkdtempSync(join(tmpdir(), 'swarmdraft-ver-'));
  mkdirSync(join(dir, 'apps/desktop/src-tauri'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      { name: 'swarmdraft', version: initialVersion, devDependencies: { eslint: '^9.0.0' } },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(
    join(dir, 'apps/desktop/package.json'),
    JSON.stringify({ name: '@swarmdraft/desktop', version: initialVersion }, null, 2) + '\n',
  );
  writeFileSync(
    join(dir, 'apps/desktop/src-tauri/tauri.conf.json'),
    `{\n  "version": "${initialVersion}",\n  "productName": "swarmDraft"\n}\n`,
  );
  writeFileSync(
    join(dir, 'apps/desktop/src-tauri/Cargo.toml'),
    `[package]\nname = "swarmdraft"\nversion = "${initialVersion}"\n\n[dependencies]\nserde = "1.0"\n`,
  );
  return dir;
}

test('versionsMatch fails when one file differs', () => {
  const dir = makeTempTree();
  try {
    assert.equal(versionsMatch(dir), true);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    pkg.version = '9.9.9';
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    assert.equal(versionsMatch(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setVersion rewrites all four and preserves dependency versions', () => {
  const dir = makeTempTree('0.1.0');
  try {
    setVersion(dir, '0.2.0-rc.1');
    const v = readVersions(dir);
    assert.equal(v.rootVer, '0.2.0-rc.1');
    assert.equal(v.desktopVer, '0.2.0-rc.1');
    assert.equal(v.tauriVer, '0.2.0-rc.1');
    assert.equal(v.cargoVer, '0.2.0-rc.1');
    const cargo = readFileSync(join(dir, 'apps/desktop/src-tauri/Cargo.toml'), 'utf8');
    assert.match(cargo, /serde = "1.0"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tagMatchesVersion accepts v prefix and prereleases', () => {
  assert.equal(tagMatchesVersion('v0.1.0', '0.1.0'), true);
  assert.equal(tagMatchesVersion('v0.2.0', '0.1.0'), false);
  assert.equal(tagMatchesVersion('v0.2.0-rc.1', '0.2.0-rc.1'), true);
});

test('check-version CLI passes on repo and rejects tag mismatch', () => {
  const ok = spawnSync(process.execPath, ['scripts/check-version.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(ok.status, 0, ok.stderr);

  const bad = spawnSync(process.execPath, ['scripts/check-version.mjs', '--tag', 'v9.9.9'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.notEqual(bad.status, 0);

  const goodTag = spawnSync(
    process.execPath,
    [
      'scripts/check-version.mjs',
      '--tag',
      `v${JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')).version}`,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
  assert.equal(goodTag.status, 0, goodTag.stderr);
});

test('release.yml policy', () => {
  const yml = readFileSync(resolve(repoRoot, '.github/workflows/release.yml'), 'utf8');
  assert.match(yml, /tags:\s*\n\s*- 'v\*'/);
  assert.match(yml, /runs-on:\s*windows-latest/);
  assert.match(yml, /pnpm tauri build --bundles nsis,msi/);
  assert.doesNotMatch(yml, /TAURI_SIGNING/i);
  assert.doesNotMatch(yml, /certificateThumbprint/);
  assert.doesNotMatch(yml, /signCommand/);
});
