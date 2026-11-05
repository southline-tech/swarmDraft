#!/usr/bin/env node
/** Real #34 evidence from `pnpm dev:web` + Chromium @ 1280×800. */
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(ROOT, '../..');
const BASE = 'http://127.0.0.1:1420';

const SHOTS = [
  ['c5-welcome', 'light', 'c5-first-run-welcome-light.png'],
  ['c5-welcome', 'dark', 'c5-first-run-welcome-dark.png'],
  ['c6-open', 'light', 'c6-second-launch-open-light.png'],
  ['c7-review-empty', 'light', 'c7-empty-review-light.png'],
  ['c8-save-failure', 'light', 'c8-save-failure-light.png'],
  ['c8-save-failure', 'dark', 'c8-save-failure-dark.png'],
  ['status-saved', 'light', 'status-saved-just-now-light.png'],
  ['error-not-word', 'light', 'error-not-word-light.png'],
  ['error-file-locked', 'light', 'error-file-locked-light.png'],
  ['error-file-damaged', 'light', 'error-file-damaged-light.png'],
  ['error-disk-full', 'light', 'error-disk-full-light.png'],
  ['error-save-failed', 'light', 'error-save-failed-light.png'],
  ['empty-comments', 'light', 'empty-comments-light.png'],
  ['empty-notes', 'light', 'empty-notes-light.png'],
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
      if ((await fetch(BASE)).ok) return;
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  throw new Error(`Dev server missing at ${BASE}`);
}

function shot(chrome, url, outPath) {
  return new Promise((ok, fail) => {
    const child = spawn(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--window-size=1280,800',
        `--screenshot=${outPath}`,
        url,
      ],
      { stdio: 'ignore' },
    );
    child.on('error', fail);
    child.on('exit', (code) =>
      code === 0 ? ok() : fail(new Error(`screenshot exit ${code}: ${url}`)),
    );
  });
}

const dev = spawn('pnpm', ['dev:web'], {
  cwd: REPO,
  stdio: 'ignore',
  env: { ...process.env, BROWSER: 'none' },
});

try {
  await waitForServer();
  const chrome = chromeBin();
  for (const [frame, theme, file] of SHOTS) {
    const url = `${BASE}/?evidence=34-install&frame=${frame}&theme=${theme}`;
    await shot(chrome, url, resolve(ROOT, file));
    console.log('wrote', file);
  }
} finally {
  dev.kill('SIGTERM');
}
