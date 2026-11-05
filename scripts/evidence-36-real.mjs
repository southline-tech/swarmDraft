#!/usr/bin/env node
/**
 * Capture pr-evidence/36 PNGs from dev:web on :1420 (real editor chrome, not shells preview).
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'pr-evidence/36');
const BASE = process.env.EVIDENCE_BASE ?? 'http://127.0.0.1:1420';
const CHROME = process.env.CHROME ?? 'google-chrome';

/** [query suffix, output filename] */
const FRAMES = [
  ['evidence=rad67&frame=wp1&theme=light', '36-editor-light.png'],
  ['evidence=rad67&frame=wp2&theme=light', '36-nav-collapsed-light.png'],
  ['evidence=rad67&frame=wp8&theme=light', '36-review-panel-light.png'],
  ['evidence=rad55&theme=light', '36-focus-mode-light.png'],
  ['evidence=rad67&frame=wp1&theme=dark', '36-editor-dark.png'],
  ['evidence=36-wp&frame=find&theme=light', '36-find-light.png'],
  ['evidence=36-wp&frame=find-replace&theme=light', '36-find-replace-light.png'],
  ['evidence=36-wp&frame=shortcuts&theme=light', '36-shortcuts-light.png'],
  ['evidence=36-wp&frame=context-menu&theme=light', '36-context-menu-light.png'],
  ['evidence=36-wp&frame=track-on&theme=light', '36-track-changes-light.png'],
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(url, ms = 60000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${url}`);
}

function shot(url, out) {
  return new Promise((res, rej) => {
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--window-size=1280,800',
      `--screenshot=${out}`,
      url,
    ];
    spawn(CHROME, args, { stdio: 'ignore' }).on('exit', (code) =>
      code === 0 ? res() : rej(new Error(`chrome exit ${code}`)),
    );
  });
}

mkdirSync(OUT, { recursive: true });
const dev = spawn('pnpm', ['dev:web'], { cwd: ROOT, stdio: 'ignore', env: process.env });
try {
  await waitFor(BASE);
  await sleep(2000);
  for (const [query, name] of FRAMES) {
    const url = `${BASE}/?${query}`;
    const path = resolve(OUT, name);
    await shot(url, path);
    console.log('wrote', name);
  }
} finally {
  dev.kill('SIGTERM');
}
