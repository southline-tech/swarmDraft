import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { expect, it } from 'vitest';

const root = resolve(__dirname, '../../..');
/** Only the desktop review UI may import the trusted entry point. */
const ALLOWED = [/^apps\/desktop\/src\/review\//, /^packages\/editor\/src\/[\w.-]+\.test\.ts$/];

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', 'target', 'gen', '.git'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(ts|vue|rs|js|mjs)$/.test(name)) yield p;
  }
}

it('agent/MCP code paths cannot import @coauthor/editor/trusted', () => {
  const offenders: string[] = [];
  for (const f of files(join(root, 'apps'))) check(f);
  for (const f of files(join(root, 'packages'))) check(f);
  function check(f: string) {
    const rel = relative(root, f).replace(/\\/g, '/');
    const src = readFileSync(f, 'utf8');
    if (
      /(from\s+|import\(\s*)['"](@coauthor\/editor\/trusted|\.{1,2}\/(\.\.\/)*trusted)['"]/.test(
        src,
      ) &&
      !ALLOWED.some((r) => r.test(rel)) &&
      rel !== 'packages/editor/src/trusted.test.ts'
    )
      offenders.push(rel);
  }
  expect(offenders).toEqual([]);
});

it('the public entry point does not re-export the trusted port factory', async () => {
  const pub = await import('./index');
  expect('createReviewPort' in pub).toBe(false);
});
