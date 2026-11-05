#!/usr/bin/env node
/**
 * Sync plugins.updater.pubkey in tauri.conf.json from the minisign .pub file
 * (base64 of full file contents, both lines). Never reads private keys.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const CONF = resolve(REPO, 'apps/desktop/src-tauri/tauri.conf.json');

function readPubBase64(path) {
  const raw = readFileSync(path, 'utf8').trim();
  if (/^dW50cnVzdGVk/.test(raw) && !raw.includes('\n')) return raw;
  return Buffer.from(raw.endsWith('\n') ? raw : `${raw}\n`, 'utf8').toString('base64');
}

function fromPromptMd(path) {
  const text = readFileSync(path, 'utf8');
  const section = text.split(/## Signing key \(done\)/i)[1];
  if (!section) throw new Error(`No "Signing key (done)" section in ${path}`);
  const m = section.match(/`([A-Za-z0-9+/=]{80,})`/);
  if (m) return m[1].trim();
  const lines = section
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('dW50cnVzdGVk'));
  if (lines[0]) return lines[0];
  throw new Error(`No pubkey base64 in Signing key section of ${path}`);
}

function resolvePubkeyB64() {
  const envFile = process.env.SWARMDRAFT_UPDATER_PUBKEY_FILE;
  if (envFile) return readPubBase64(resolve(envFile));
  const homePub = resolve(homedir(), '.tauri/swarmdraft-updater.key.pub');
  try {
    return readPubBase64(homePub);
  } catch {
    /* try prompt file */
  }
  const prompt = resolve(homedir(), 'Downloads/prompts-2026-11-04-310-updater.md');
  return fromPromptMd(prompt);
}

const pubkey = resolvePubkeyB64();
const conf = JSON.parse(readFileSync(CONF, 'utf8'));
conf.plugins ??= {};
conf.plugins.updater ??= {};
conf.plugins.updater.pubkey = pubkey;
writeFileSync(CONF, `${JSON.stringify(conf, null, 2)}\n`);
console.error('sync-updater-pubkey: updated plugins.updater.pubkey');
