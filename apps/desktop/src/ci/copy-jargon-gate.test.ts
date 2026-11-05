/** CI gate: copy jargon check runs in Linux job (#34). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(process.cwd(), '../..');
const ciYml = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8');
const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('copy jargon in CI (#34)', () => {
  it('runs pnpm copy:check after lint', () => {
    expect(ciYml).toMatch(
      /- run: pnpm lint\n\s+- run: pnpm copy:check\n\s+- run: pnpm format:check/,
    );
  });

  it('exposes copy:check script', () => {
    expect(pkg.scripts['copy:check']).toBe('node scripts/check-copy-jargon.mjs');
  });
});
