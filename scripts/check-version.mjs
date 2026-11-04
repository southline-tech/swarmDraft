#!/usr/bin/env node
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalVersion, tagMatchesVersion, versionsMatch } from './version-files.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (!versionsMatch(root)) {
  console.error('Version mismatch across package.json files, tauri.conf.json, and Cargo.toml');
  process.exit(1);
}

const version = canonicalVersion(root);
let tag = null;
const tagIdx = process.argv.indexOf('--tag');
if (tagIdx >= 0 && process.argv[tagIdx + 1]) {
  tag = process.argv[tagIdx + 1];
} else if (process.env.GITHUB_REF_NAME?.startsWith('v')) {
  tag = process.env.GITHUB_REF_NAME;
}

if (tag && !tagMatchesVersion(tag, version)) {
  console.error(`Tag ${tag} does not match repo version ${version} (expected v${version})`);
  process.exit(1);
}

console.log(`Version OK: ${version}${tag ? ` (tag ${tag})` : ''}`);
