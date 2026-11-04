#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setVersion } from './version-files.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];

if (!version) {
  console.error('Usage: node scripts/set-version.mjs <semver>');
  process.exit(1);
}

try {
  setVersion(root, version);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const tauriDir = resolve(root, 'apps/desktop/src-tauri');
try {
  execSync('cargo update -p swarmdraft --offline', { cwd: tauriDir, stdio: 'inherit' });
} catch {
  execSync('cargo update -p swarmdraft', { cwd: tauriDir, stdio: 'inherit' });
}

console.log(`Set version to ${version} in package.json, tauri.conf.json, and Cargo.toml`);
