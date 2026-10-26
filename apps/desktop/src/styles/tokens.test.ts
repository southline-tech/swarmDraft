import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// vitest runs from apps/desktop; read the raw file (CSS imports are stubbed in tests).
const css = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8');

/** Returns the declaration bodies of every rule whose selector matches exactly. */
function rules(selector: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const sel = (m[1] ?? '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim()
      .replace(/\s+/g, ' ');
    if (sel === selector) out.push(m[2] ?? '');
  }
  return out;
}

const derived = [
  '--ct-suggest-insert-bg',
  '--ct-suggest-insert-underline',
  '--ct-suggest-delete-bg',
  '--ct-suggest-delete-text',
  '--ct-suggest-delete-strike',
];

describe('suggestion tokens', () => {
  it('keeps only the base --ct-suggester on :root', () => {
    const root = rules(':root').join('\n');
    expect(root).toContain('--ct-suggester: var(--ct-collab-1)');
    for (const name of derived) expect(root).not.toContain(`${name}:`);
  });

  it('declares derived tokens per element on :where([data-suggester])', () => {
    const body = rules(':where([data-suggester])').join('\n');
    for (const name of derived) expect(body).toContain(`${name}:`);
    expect(body).toMatch(/--ct-suggest-insert-underline:\s*var\(--ct-suggester\)/);
  });

  it('applies the dark override at zero specificity under the mark', () => {
    const dark = rules(":where([data-theme='dark'] [data-suggester])").join('\n');
    expect(dark).toMatch(/--ct-suggest-insert-bg:.*var\(--ct-suggester\) 22%/);
    expect(rules('[data-theme="dark"]').join('\n')).not.toContain('--ct-suggest-');
  });

  it('lets a nested element resolve its own suggester color', () => {
    // Simulated cascade: the derived token is re-declared on each [data-suggester]
    // element, so var(--ct-suggester) resolves against that element's value.
    const underline =
      /--ct-suggest-insert-underline:\s*var\((--[\w-]+)\)/.exec(
        rules(':where([data-suggester])')[0] ?? '',
      )?.[1] ?? '';
    const outer: Record<string, string> = { '--ct-suggester': 'var(--ct-collab-2)' };
    const inner: Record<string, string> = { ...outer, '--ct-suggester': 'var(--ct-collab-5)' };
    expect(outer[underline]).toBe('var(--ct-collab-2)');
    expect(inner[underline]).toBe('var(--ct-collab-5)');
  });
});
