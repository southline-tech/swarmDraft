/** CI review gate (#252): Prettier must run in the existing Linux check job. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(process.cwd(), '../..');
const ciYml = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8');
const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('Prettier in CI (#252)', () => {
  it('runs pnpm format:check in the Lint and test job after lint', () => {
    expect(ciYml).toMatch(
      /- run: pnpm lint\n\s+- run: pnpm format:check\n\s+- run: pnpm typecheck/s,
    );
  });

  it('exposes local format and format:check scripts', () => {
    expect(pkg.scripts.format).toBe('prettier --write .');
    expect(pkg.scripts['format:check']).toBe('prettier --check .');
  });

  it('uses the repo Prettier config', () => {
    const cfg = JSON.parse(readFileSync(resolve(repoRoot, '.prettierrc.json'), 'utf8')) as {
      singleQuote: boolean;
    };
    expect(cfg.singleQuote).toBe(true);
  });
});
