import { describe, expect, it } from 'vitest';
import { addSection } from './outline';
import { planChapterMerge, planSplitChapterOutline, splitChapterDocs } from './chapter-split-merge';
import type { DocNode } from '@swarmdraft/schema';

const PARAS = 3500;

describe('chapter split/merge perf (#304)', () => {
  it('split and merge plans stay under 300ms on a large chapter', () => {
    const blocks = Array.from({ length: PARAS }, (_, i) => ({
      type: 'paragraph' as const,
      attrs: { style: 'body' as const },
      content: [{ type: 'text' as const, text: `Para ${i}` }],
    }));
    const doc: DocNode = { type: 'doc', content: blocks };
    let outline = addSection([], { manuscriptId: 'm', kind: 'chapter', title: 'Big', id: 'big' });
    outline = addSection(outline, { manuscriptId: 'm', kind: 'chapter', title: 'Next', id: 'n1' });
    const t0 = performance.now();
    const split = splitChapterDocs(doc, Math.floor(PARAS / 2), { removeTitleLine: false });
    const plan = planSplitChapterOutline(outline, 'm', 'big', 'Part two');
    const merge = planChapterMerge(
      plan.sections,
      'big',
      plan.newChapterId,
      split.before,
      split.after,
      'Part two',
    );
    const ms = performance.now() - t0;
    expect(merge.sections.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(300);
  });
});
