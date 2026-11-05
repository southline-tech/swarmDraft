import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome';

const scenes = [
  ['scene-home-import.html', 'home-import-wording.png'],
  ['scene-progress-import.html', 'progress-mid-big-file.png'],
  ['scene-cancel-result.html', 'cancel-result.png'],
  ['scene-import-error.html', 'error-state.png'],
  ['scene-book-menu.html', 'book-menu-import-open.png'],
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function shot(html, png) {
  const url = `file://${path.join(ROOT, html)}`;
  await new Promise((resolve, reject) => {
    const proc = spawn(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        `--window-size=1280,800`,
        `--screenshot=${path.join(ROOT, png)}`,
        url,
      ],
      { stdio: 'inherit' },
    );
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`chrome exit ${code}`))));
  });
  await sleep(200);
}

for (const [html, png] of scenes) {
  await shot(html, png);
  console.log('wrote', png);
}
