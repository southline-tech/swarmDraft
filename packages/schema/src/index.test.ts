import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRIM,
  INLINE_NODE_TYPES,
  MARK_TYPES,
  NON_EXCLUSIVE_MARKS,
  TRIM_SIZES,
  isSectionKind,
} from './index';

describe('schema', () => {
  it('defaults to 6x9 trim', () => {
    expect(DEFAULT_TRIM).toBe('6x9');
    expect(TRIM_SIZES[DEFAULT_TRIM]).toEqual({ widthIn: 6, heightIn: 9 });
  });

  it('recognises section kinds', () => {
    expect(isSectionKind('scene')).toBe(false);
    expect(isSectionKind('appendix')).toBe(false);
  });
});

describe('doc ids', () => {
  it('addresses each section separately', async () => {
    const { manuscriptDocId, sectionDocId } = await import('./index');
    expect(manuscriptDocId('m1')).toBe('manuscript/m1');
    expect(sectionDocId('m1', 'c2')).toBe('manuscript/m1/section/c2');
  });
});

describe('content model', () => {
  it('declares import nodes and marks', () => {
    expect(INLINE_NODE_TYPES).toEqual(['text', 'hard_break', 'footnote', 'image']);
    expect(MARK_TYPES).toContain('underline');
    expect(NON_EXCLUSIVE_MARKS).toContain('comment_anchor');
  });
});
