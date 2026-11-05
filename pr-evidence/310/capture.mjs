#!/usr/bin/env node
/** #310 update prompt evidence @ 1280×800 via dev harness (`?evidence=310-updater`). */
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(ROOT, '../..');
const BASE = 'http://127.0.0.1:1420';

const SHOTS = [
  ['available', 'update-available.png'],
  ['progress', 'update-progress.png'],
  ['up-to-date', 'update-up-to-date.png'],
];

function chromeBin() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const c of ['google-chrome', 'chromium-browser', 'chromium']) {
    const r = spawnSync('which', [c], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return c;
  }
  return 'google-chrome';
}

async function waitForServer(maxMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(BASE);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  throw new Error('dev server did not start');
}

async function screenshot(url, out) {
  const bin = chromeBin();
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1280,800',
    `--screenshot=${out}`,
    url,
  ];
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || `chrome failed for ${out}`);
}

const dev = spawn('pnpm', ['dev:web'], { cwd: REPO, stdio: 'ignore' });
try {
  await waitForServer();
  for (const [frame, file] of SHOTS) {
    const out = resolve(ROOT, file);
    await screenshot(`${BASE}/?evidence=310-updater&frame=${frame}`, out);
    console.log('wrote', file);
  }
} finally {
  dev.kill('SIGTERM');
}
