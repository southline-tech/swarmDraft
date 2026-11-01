import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** Full #37 audit: every shipped .vue / .css style block uses tokens only. */
const root = resolve(process.cwd(), 'src');
const skipDir = new Set(['node_modules', 'evidence', 'fonts']);
const skipFile = new Set([join(root, 'styles/tokens.css')]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return skipDir.has(name) ? [] : walk(p);
    return /\.(vue|css)$/.test(name) ? [p] : [];
  });
}

function styleCss(path: string, text: string): string {
  const blocks: string[] = [];
  if (path.endsWith('.vue')) {
    for (const m of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) blocks.push(m[1] ?? '');
  } else {
    blocks.push(text);
  }
  return blocks.join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
}

const defined = new Set(
  [...readFileSync(join(root, 'styles/tokens.css'), 'utf8').matchAll(/(--ct-[\w-]+)\s*:/g)].map(
    (m) => m[1],
  ),
);

const audited = walk(root).filter((p) => !skipFile.has(p));

describe('design token sweep (#37)', () => {
  it('audits every .vue and .css file under src/', () => {
    expect(audited.length).toBeGreaterThan(40);
  });

  it.each(audited.map((p) => relative(root, p)))(
    '%s styles use no hard-coded hex or rgb colors',
    (rel) => {
      const css = styleCss(join(root, rel), readFileSync(join(root, rel), 'utf8'));
      expect(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
      expect(css).not.toMatch(/\brgb\s*\(/);
      expect(css).not.toMatch(/\brgba\s*\(/);
    },
  );

  it.each(audited.map((p) => relative(root, p)))(
    '%s avoids raw Georgia / system-ui font stacks',
    (rel) => {
      const css = styleCss(join(root, rel), readFileSync(join(root, rel), 'utf8'));
      expect(css).not.toMatch(/\b(Georgia|system-ui)\b/);
      expect(css).not.toMatch(/font-family:\s*['"]Inter['"]/);
      expect(css).not.toMatch(/font-family:\s*['"]Literata['"]/);
    },
  );

  it.each(audited.map((p) => relative(root, p)))(
    '%s only references defined --ct-* tokens',
    (rel) => {
      const css = styleCss(join(root, rel), readFileSync(join(root, rel), 'utf8'));
      const used = [...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1] ?? '');
      expect(used.filter((v) => v.startsWith('--ct-') && !defined.has(v))).toEqual([]);
    },
  );
});
