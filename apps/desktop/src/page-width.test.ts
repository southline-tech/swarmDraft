import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// #92/#105: layout isn't computed in jsdom, so these check the shipped rules; widths were measured
// in Chromium at 1024/1152/1199/1280/1440px (no sideways scroll, page >= 440px).
const sfc = readFileSync(resolve(__dirname, 'ManuscriptEditor.vue'), 'utf8');
const css = sfc.slice(sfc.indexOf('<style'));
const rule = (sel: string) => {
  const i = css.indexOf(`${sel} {`);
  return i < 0 ? '' : css.slice(i, css.indexOf('}', i)).replace(/\s+/g, ' ');
};

describe('fluid page column (#92, #105)', () => {
  it('fills the desk minus gutters, never below 440px, with no fixed max page width', () => {
    expect(rule('.manuscript-editor .page-sheet')).toContain(
      'width: max(var(--ct-page-min-w), 100% - 2 * var(--ct-page-gutter) - var(--ct-page-notes-room));',
    );
    expect(rule('.manuscript-editor .page-sheet')).not.toContain('--ct-page-w');
  });

  it('caps the text column at --ct-measure-page, centered inside the page padding', () => {
    const tiptap = rule('.manuscript-editor .page .tiptap');
    expect(tiptap).toContain('max-width: var(--ct-measure-page);');
    expect(tiptap).toContain('margin-left: auto;');
    expect(tiptap).toContain('margin-right: auto;');
  });

  it('no fixed-width utility class on the page sheet', () => {
    const tag = sfc.slice(sfc.indexOf('class="page-sheet'), sfc.indexOf('data-test="page"'));
    expect(tag).not.toMatch(/\bw-\d+/);
  });

  it('leaves room for the margin notes when they show', () => {
    expect(rule('.manuscript-editor .desk:has(> .sh-margin)')).toContain(
      '--ct-page-notes-room: calc(var(--ct-margin-notes-w) + var(--ct-space-4));',
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

describe('forced outline page (#96)', () => {
  it('never goes below 320px inside the gutters while the outline is forced, with no 576px cap', () => {
    expect(rule('.manuscript-editor .desk--outline-forced .page-sheet')).toContain(
      'width: max( var(--ct-page-forced-min-w), 100% - 2 * var(--ct-page-gutter) - var(--ct-page-notes-room) );',
    );
    expect(rule('.manuscript-editor .desk--outline-forced .page-sheet')).not.toContain(
      '--ct-page-w',
    );
  });
  it('uses --ct-space-8 inner side padding when the page is under 440px', () => {
    const r = rule('.manuscript-editor .page-sheet.page-sheet--narrow');
    expect(r).toContain('padding-left: var(--ct-space-8);');
    expect(r).toContain('padding-right: var(--ct-space-8);');
  });
  it('binds both classes in the template', () => {
    expect(sfc).toContain(':class="{ \'desk--outline-forced\': outlineForced }"');
    expect(sfc).toContain(':class="{ \'page-sheet--narrow\': pageNarrow }"');
  });
});

describe('page measure token (#105)', () => {
  it('is 70ch in tokens.css', () => {
    const tokens = readFileSync(resolve(__dirname, 'styles/tokens.css'), 'utf8');
    expect(tokens).toContain('--ct-measure-page: 70ch;');
    expect(tokens).not.toContain('--ct-page-w');
  });
});
