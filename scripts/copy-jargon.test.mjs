import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = resolve(import.meta.dirname, '..');
const checker = join(repoRoot, 'scripts/check-copy-jargon.mjs');
const deckPath = join(repoRoot, 'apps/desktop/src/copy-deck.ts');

describe('copy jargon check (#34)', () => {
  it('passes on the repo copy deck and UI templates', () => {
    execSync(`node "${checker}"`, { cwd: repoRoot, stdio: 'pipe' });
  });

  it('fails when a banned word appears in copy-deck.ts', () => {
    const backup = readFileSync(deckPath, 'utf8');
    writeFileSync(deckPath, 'export const probe = "uses database jargon";\n');
    let failed = false;
    try {
      execSync(`node "${checker}"`, { cwd: repoRoot, stdio: 'pipe' });
    } catch {
      failed = true;
    } finally {
      writeFileSync(deckPath, backup);
    }
    assert.equal(failed, true);
  });

  it('fails when MCP appears in copy-deck.ts', () => {
    const backup = readFileSync(deckPath, 'utf8');
    writeFileSync(deckPath, 'export const probe = "MCP connected";\n');
    let failed = false;
    try {
      execSync(`node "${checker}"`, { cwd: repoRoot, stdio: 'pipe' });
    } catch {
      failed = true;
    } finally {
      writeFileSync(deckPath, backup);
    }
    assert.equal(failed, true);
  });
});
