import { describe, expect, it } from 'vitest';
import { addSection } from './outline';
import {
  planChapterMerge,
  planSplitChapterOutline,
  reviewBlocksSplit,
  splitChapterDocs,
  suggestSplitTitle,
} from './chapter-split-merge';
import type { DocNode, Section } from '@swarmdraft/schema';

function sampleOutline(): Section[] {
  return addSection([], { manuscriptId: 'm', kind: 'chapter', title: 'One', id: 'c1' });
}

describe('chapter split/merge (#304)', () => {
  it('suggests title from first line', () => {
    expect(suggestSplitTitle('Chapter 12', 3).title).toBe('Chapter 12');
    expect(suggestSplitTitle('', 3).title).toBe('Chapter 3');
  });

  it('plans split outline after current chapter', () => {
    const plan = planSplitChapterOutline(sampleOutline(), 'm', 'c1', 'New bit');
    expect(plan.sections).toHaveLength(2);
    expect(plan.sections[1]!.title).toBe('New bit');
    expect(plan.sections[0]!.id).toBe('c1');
  });

  it('splits doc at block index', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { style: 'body' }, content: [{ type: 'text', text: 'A' }] },
        { type: 'paragraph', attrs: { style: 'body' }, content: [{ type: 'text', text: 'B' }] },
      ],
    };
    const split = splitChapterDocs(doc, 1, { removeTitleLine: true });
    expect(split.before.content).toHaveLength(1);
    expect(split.after.content?.[0]).toMatchObject({ type: 'paragraph' });
  });

  it('blocks split when review marks sit on boundary', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { style: 'body' }, content: [{ type: 'text', text: 'A' }] },
        {
          type: 'paragraph',
          attrs: { style: 'body' },
          content: [
            {
              type: 'text',
              text: 'B',
              marks: [{ type: 'suggestion_insert', attrs: { id: 's1', author: 'a', ts: '1' } }],
            },
          ],
        },
      ],
    };
    expect(reviewBlocksSplit(doc, 1)).toBe(true);
  });

  it('merges chapters in outline and doc', () => {
    let outline = sampleOutline();
    outline = addSection(outline, { manuscriptId: 'm', kind: 'chapter', title: 'Two', id: 'c2' });
    const target: DocNode = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { style: 'body' }, content: [{ type: 'text', text: 'T' }] },
      ],
    };
    const source: DocNode = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { style: 'body' }, content: [{ type: 'text', text: 'S' }] },
      ],
    };
    const plan = planChapterMerge(outline, 'c1', 'c2', target, source, 'Two');
    expect(plan.sections).toHaveLength(1);
    expect(JSON.stringify(plan.mergedDoc)).toContain('Two');
    expect(JSON.stringify(plan.mergedDoc)).toContain('S');
  });
});
