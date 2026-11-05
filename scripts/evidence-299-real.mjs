#!/usr/bin/env node
/**
 * Capture pr-evidence/299 PNGs from the real Vue app (pnpm dev:web → :1420).
 * Same import UI as `pnpm tauri dev`. Run with dev server already up.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'pr-evidence/299');
const LARGE = resolve(ROOT, 'fixtures/manuscripts/large-synthetic/large-synthetic.docx');
const MOCK = resolve(ROOT, 'fixtures/manuscripts/docx-import/mock-manuscript.docx');
const BASE = process.env.EVIDENCE_BASE ?? 'http://127.0.0.1:1420';
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome';
const PORT = Number(process.env.CDP_PORT ?? 9225);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

function injectFile(cdp, sessionId, bytes, name) {
  const b64 = Buffer.from(bytes).toString('base64');
  return evalExpr(
    cdp,
    sessionId,
    `(async () => {
      const bytes = Uint8Array.from(atob('${b64}'), (c) => c.charCodeAt(0));
      const input = document.querySelector('[data-test="open-docx"]');
      const file = new File([bytes], '${name}', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`,
  );
}

async function main() {
  readFileSync(LARGE);
  readFileSync(MOCK);
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      `--remote-debugging-port=${PORT}`,
      '--window-size=1280,800',
    ],
    { stdio: 'ignore' },
  );
  try {
    await sleep(900);
    const version = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json());
    const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    const { targetId } = await cdp.send('Target.createTarget', { url: `${BASE}/` });
    await sleep(1200);
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );

    await evalExpr(
      cdp,
      sessionId,
      `localStorage.setItem('swarmdraft.welcomed', '1'); location.reload();`,
    );
    await sleep(1200);
    await shot(cdp, sessionId, 'home-import-wording.png');

    await injectFile(cdp, sessionId, readFileSync(MOCK), 'mock-manuscript.docx');
    await sleep(3000);
    await injectFile(cdp, sessionId, readFileSync(LARGE), 'large-synthetic.docx');
    await sleep(400);
    await shot(cdp, sessionId, 'progress-mid-big-file.png');
    await evalExpr(
      cdp,
      sessionId,
      `document.querySelector('[data-test="opening-cancel"]')?.click();`,
    );
    await sleep(1200);
    await shot(cdp, sessionId, 'cancel-result.png');

    await injectFile(cdp, sessionId, new Uint8Array([1, 2, 3]), 'broken.docx');
    await sleep(2000);
    await shot(cdp, sessionId, 'error-state.png');

    await evalExpr(
      cdp,
      sessionId,
      `document.querySelector('[data-test="app-menu-trigger"]')?.click();`,
    );
    await sleep(600);
    await shot(cdp, sessionId, 'book-menu-import-open.png');
    cdp.close();
  } finally {
    chrome.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
