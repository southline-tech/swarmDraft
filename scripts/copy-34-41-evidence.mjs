#!/usr/bin/env node
/** Copy merged batch screenshots into pr-evidence/34-41/ (release checklist #34). */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ev = join(root, 'pr-evidence/34-41');
mkdirSync(ev, { recursive: true });

const pairs = [
  ['pr-evidence/34/c5-first-run-welcome-light.png', 'welcome.png'],
  ['pr-evidence/299/home-import-wording.png', 'import.png'],
  ['pr-evidence/299/progress-mid-big-file.png', 'opening-progress.png'],
  ['pr-evidence/36/36-editor-light.png', 'editor.png'],
  ['pr-evidence/34/status-saved-just-now-light.png', 'save-status.png'],
  ['pr-evidence/310/update-available.png', 'update-prompt.png'],
  ['pr-evidence/299/error-state.png', 'error-card.png'],
  ['pr-evidence/34/c7-empty-review-light.png', 'empty-states.png'],
  ['docs/pr-evidence/39/export-light.png', 'export-settings.png'],
  ['docs/pr-evidence/192/ap4-removed-agents-collapsed-light.png', 'agents.png'],
];

for (const [src, dest] of pairs) {
  copyFileSync(join(root, src), join(ev, dest));
}
console.log(`copied ${pairs.length} screenshots → pr-evidence/34-41/`);
