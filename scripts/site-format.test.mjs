/** Issue #292: root Prettier must cover site/** static landing. */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = resolve(import.meta.dirname, '..');
const siteIndex = resolve(repoRoot, 'site/index.html');

describe('site Prettier scope (#292)', () => {
  it('site/index.html exists', () => {
    assert.equal(existsSync(siteIndex), true);
  });

  it('prettier --check passes on site/**', () => {
    execSync('pnpm exec prettier --check "site/**/*.{html,css,js,md,ts}"', {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  });
});
