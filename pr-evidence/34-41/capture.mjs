#!/usr/bin/env node
/**
 * Capture pr-evidence/34-41 PNGs from the running app (pnpm tauri dev or pnpm dev:web → :1420).
 * Uses real Vue components via ?evidence=34-41&frame=… @ 1280×800.
 */
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(ROOT, '../..');
const OUT = ROOT;
const BASE = process.env.EVIDENCE_BASE ?? 'http://127.0.0.1:1420';
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome';
const PORT = Number(process.env.CDP_PORT ?? 9226);

const SHOTS = [
  ['welcome', 'welcome.png'],
  ['import', 'import.png'],
  ['opening-progress', 'opening-progress.png'],
  ['editor', 'editor.png'],
  ['save-status', 'save-status.png'],
  ['update-prompt', 'update-prompt.png'],
  ['error-card', 'error-card.png'],
  ['empty-states', 'empty-states.png'],
  ['export-settings', 'export-settings.png'],
  ['agents', 'agents.png'],
];

function chromeBin() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const c of ['google-chrome', 'chromium-browser', 'chromium']) {
    const r = spawnSync('which', [c], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return CHROME;
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

class Cdp {
  #ws;
  #id = 0;
  #pending = new Map();
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    return new Cdp(ws);
  }
  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.#pending.has(msg.id)) {
        const { res, rej } = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    return new Promise((res, rej) => {
      this.#pending.set(id, { res, rej });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.#ws.send(JSON.stringify(payload));
    });
  }
  close() {
    this.#ws.close();
  }
}

async function evalExpr(cdp, sessionId, expression) {
  const { result, exceptionDetails } = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails));
  return result.value;
}

async function shot(cdp, sessionId, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(resolve(OUT, name), Buffer.from(data, 'base64'));
  console.log('wrote', name);
}

const spawnDev = process.env.EVIDENCE_BASE != null;
let dev;
if (!spawnDev) {
  dev = spawn('pnpm', ['dev:web'], {
    cwd: REPO,
    stdio: 'ignore',
    env: { ...process.env, BROWSER: 'none' },
  });
}

try {
  await waitForServer();
  await sleep(spawnDev ? 500 : 2500);
  const chrome = spawn(
    chromeBin(),
    [
      '--headless=new',
      '--disable-gpu',
      `--remote-debugging-port=${PORT}`,
      '--window-size=1280,800',
    ],
    { stdio: 'ignore' },
  );
  try {
    await sleep(800);
    const version = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json());
    const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    const { targetId } = await cdp.send('Target.createTarget', { url: `${BASE}/` });
    await sleep(400);
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );

    for (const [frame, file] of SHOTS) {
      const url = `${BASE}/?evidence=34-41&frame=${encodeURIComponent(frame)}&theme=light`;
      await cdp.send('Page.navigate', { url }, sessionId);
      await evalExpr(
        cdp,
        sessionId,
        `new Promise((resolve, reject) => {
          const deadline = Date.now() + 45000;
          (function tick() {
            const el = document.querySelector('[data-test="evidence-3441"][data-frame="${frame}"]');
            if (el) return resolve(true);
            if (Date.now() > deadline) return reject(new Error('timeout waiting for ${frame}'));
            requestAnimationFrame(tick);
          })();
        })`,
      );
      await sleep(
        frame === 'editor' || frame === 'agents' || frame === 'update-prompt' ? 900 : 350,
      );
      await shot(cdp, sessionId, file);
    }
    cdp.close();
  } finally {
    chrome.kill();
  }
} finally {
  dev?.kill('SIGTERM');
}
