import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// vitest runs from apps/desktop. --ct-focus-ring is a box-shadow value; anywhere
// else (outline, border, color, ...) it is invalid and the focus ring vanishes.
const root = resolve(process.cwd(), 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : files(p);
    return /\.(vue|css)$/.test(name) ? [p] : [];
  });
}

/** Returns `file:line property` for every --ct-focus-ring use outside box-shadow. */
export function misuses(path: string, text: string): string[] {
  const out: string[] = [];
  const src = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const re = /([-\w]+)\s*:([^;{}]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const prop = (m[1] ?? '').toLowerCase();
    if (!/--ct-focus-ring(?![-\w])/.test(m[2] ?? '')) continue;
    if (prop === 'box-shadow' || prop.startsWith('--')) continue;
    const line = src.slice(0, m.index).split('\n').length;
    out.push(`${relative(root, path)}:${line} ${prop}`);
  }
  return out;
}

describe('--ct-focus-ring usage', () => {
  it('is used only in box-shadow in every .vue and .css file', () => {
    const all = files(root);
    expect(all.length).toBeGreaterThan(10);
    const bad = all.flatMap((f) => misuses(f, readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });

  it('flags outline, border and color uses but not box-shadow or -color', () => {
    const css = `a{outline:2px solid var(--ct-focus-ring)}
b{border: 1px solid var(--ct-focus-ring);color:var(--ct-focus-ring)}
c{box-shadow: var(--ct-focus-ring); outline: 2px solid var(--ct-focus-ring-color)}
:root{--x: var(--ct-focus-ring)}`;
    expect(misuses(join(root, 'x.css'), css).map((s) => s.split(' ')[1])).toEqual([
      'outline',
      'border',
      'color',
    ]);
  });
});
