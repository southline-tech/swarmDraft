import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome';
const PORT = Number(process.env.CDP_PORT ?? 9224);

const scenes = [
  ['scene-empty.html', 'feedback-empty-light.png'],
  ['scene-validation.html', 'feedback-validation-light.png'],
  ['scene-send-error.html', 'feedback-send-error-light.png'],
  ['scene-success.html', 'feedback-success-light.png'],
];

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

async function main() {
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      `--remote-debugging-port=${PORT}`,
      '--window-size=720,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  try {
    await sleep(700);
    const version = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json());
    const cdp = await Cdp.connect(version.webSocketDebuggerUrl);

    console.log('PNG\tcard_width_px');
    for (const [html, png] of scenes) {
      const url = `file://${path.join(ROOT, html)}`;
      const { targetId } = await cdp.send('Target.createTarget', { url });
      await sleep(400);
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await cdp.send('Runtime.enable', {}, sessionId);
      const { result } = await cdp.send(
        'Runtime.evaluate',
        {
          expression: `Math.round(document.querySelector('.st-dlg--feedback').getBoundingClientRect().width)`,
          returnByValue: true,
        },
        sessionId,
      );
      console.log(`${png}\t${result.value}`);
      await cdp.send('Target.closeTarget', { targetId });
    }
    cdp.close();
  } finally {
    chrome.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
