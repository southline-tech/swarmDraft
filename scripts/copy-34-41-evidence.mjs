#!/usr/bin/env node
/** Run fresh 1280×800 captures into pr-evidence/34-41/ (see pr-evidence/34-41/README.md). */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const capture = resolve(root, 'pr-evidence/34-41/capture.mjs');
const r = spawnSync(process.execPath, [capture], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
