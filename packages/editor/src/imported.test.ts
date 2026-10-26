import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importDocx } from '@coauthor/docx';
import { createManuscriptEditor, collectReviewItems } from './index';

// Synthetic fixtures only (fixtures/manuscripts/docx-import); no real manuscript text.
// Vitest runs with the package as cwd (happy-dom rewrites import.meta.url).
const dir = resolve(process.cwd(), '../../fixtures/manuscripts/docx-import') + '/';
const files = readdirSync(dir).filter((f) => f.endsWith('.docx'));

describe('editor loads imported .docx sections losslessly', () => {
  it('has fixtures', () => expect(files.length).toBeGreaterThan(0));
  for (const f of files) {
    it(f, () => {
      const m = importDocx(readFileSync(dir + f), { manuscriptId: 'm1' });
      // Container sections (e.g. a part with no body text) have no content to load.
      for (const s of m.sections.filter((x) => x.content.content.length)) {
        const editor = createManuscriptEditor({ content: s.content });
        expect(editor.getJSON()).toEqual(s.content);
        editor.destroy();
      }
    });
  }

  it('renders footnotes, tracked changes and comments from the mock manuscript', () => {
    const m = importDocx(readFileSync(dir + 'mock-manuscript.docx'), { manuscriptId: 'm1' });
    let notes = 0;
    let review = 0;
    for (const s of m.sections) {
      const editor = createManuscriptEditor({ content: s.content });
      notes += editor.view.dom.querySelectorAll('sup[data-note]').length;
      review += collectReviewItems(editor.state.doc).length;
      editor.destroy();
    }
    expect(notes).toBeGreaterThan(0);
    expect(review).toBeGreaterThan(0);
  });
});
