import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// #92: layout isn't computed in jsdom, so these check the shipped rules; the widths were measured
// in Chromium at 1024/1152/1199/1280/1440px (no sideways scroll, page >= 440px).
const sfc = readFileSync(resolve(__dirname, 'ManuscriptEditor.vue'), 'utf8');
const css = sfc.slice(sfc.indexOf('<style'));
const rule = (sel: string) => {
  const i = css.indexOf(`${sel} {`);
  return i < 0 ? '' : css.slice(i, css.indexOf('}', i)).replace(/\s+/g, ' ');
};

describe('fluid page column (#92)', () => {
  it('is min(576px, desk minus gutters), never below 440px, from tokens', () => {
    expect(rule('.manuscript-editor .page-sheet')).toContain(
      'width: max( var(--ct-page-min-w), min(var(--ct-page-w), 100% - 2 * var(--ct-page-gutter) - var(--ct-page-notes-room)) );',
    );
  });

  it('no fixed-width utility class on the page sheet', () => {
    const tag = sfc.slice(sfc.indexOf('class="page-sheet'), sfc.indexOf('data-test="page"'));
    expect(tag).not.toMatch(/\bw-\d+/);
  });

  it('leaves room for the margin notes when they show', () => {
    expect(rule('.manuscript-editor .desk:has(> .sh-margin)')).toContain(
      '--ct-page-notes-room: var(--ct-margin-notes-w);',
    );
  });

  it('the open review panel never narrows below --ct-panel-w-narrow', () => {
    expect(rule('.manuscript-editor .review:not(.review--collapsed)')).toContain(
      'min-width: var(--ct-panel-w-narrow);',
    );
  });
});

describe('review panel at narrow widths (#92)', () => {
  it('is exactly --ct-panel-w-narrow below 1200px, and its children fill it', () => {
    const m = css.indexOf('@media (max-width: 1199.98px)');
    expect(m).toBeGreaterThan(-1);
    const inMedia = css.slice(m, css.indexOf('}', css.indexOf('{', m) + 1) + 1);
    expect(inMedia.replace(/\s+/g, ' ')).toContain('width: var(--ct-panel-w-narrow);');
    expect(rule('.manuscript-editor .review:not(.review--collapsed) > *')).toContain(
      'width: 100%;',
    );
  });
});

it('the open review panel has a fixed --ct-panel-w width at 1200px and up (#92)', () => {
  expect(rule('.manuscript-editor .review:not(.review--collapsed)')).toContain(
    'width: var(--ct-panel-w);',
  );
});
