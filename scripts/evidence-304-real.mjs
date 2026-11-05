#!/usr/bin/env node
/**
 * Capture pr-evidence/304 PNGs from dev:web on :1420 (?evidence=304-chapter&frame=…).
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'pr-evidence/304');
const BASE = process.env.EVIDENCE_BASE ?? 'http://127.0.0.1:1420';
const CHROME = process.env.CHROME ?? 'google-chrome';

const FRAMES = [
  ['context-menu', '304-context-menu-light.png'],
  ['split-popover', '304-split-popover-light.png'],
  ['merge-confirm', '304-merge-confirm-light.png'],
  ['chapter-toast', '304-chapter-toast-light.png'],
  ['split-across-pill', '304-split-across-pill-light.png'],
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
    const cmd = CHROME;
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--window-size=900,700',
      `--screenshot=${out}`,
      url,
    ];
    spawn(cmd, args, { stdio: 'ignore' }).on('exit', (code) =>
      code === 0 ? res() : rej(new Error(`chrome exit ${code}`)),
    );
  });
}

mkdirSync(OUT, { recursive: true });
const dev = spawn('pnpm', ['dev:web'], { cwd: ROOT, stdio: 'ignore', env: process.env });
try {
  await waitFor(BASE);
  await sleep(1500);
  for (const [frame, name] of FRAMES) {
    const url = `${BASE}/?evidence=304-chapter&frame=${frame}&theme=light`;
    const path = resolve(OUT, name);
    await shot(url, path);
    console.log('wrote', name);
  }
} finally {
  dev.kill('SIGTERM');
}
