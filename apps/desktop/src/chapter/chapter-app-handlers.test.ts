import { describe, expect, it, vi } from 'vitest';
import { chapterToastUndoHint, notesLinkSpan, notesLinkedDetail } from './chapter-app-handlers';

describe('chapter toast (#304)', () => {
  it('shows platform undo hint when toast undo is blocked', () => {
    vi.stubGlobal('navigator', { platform: 'Win32' });
    expect(chapterToastUndoHint()).toBe('Text changed since this, use Ctrl+Z');
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    expect(chapterToastUndoHint()).toBe('Text changed since this, use ⌘Z');
    vi.unstubAllGlobals();
  });
});

describe('chapter break note detail (#305)', () => {
  it('names both chapters for one new chapter and every chapter when there are more', () => {
    expect(notesLinkedDetail(1)).toBeUndefined();
    expect(notesLinkedDetail(2)).toBe('Notes linked to both chapters');
    expect(notesLinkedDetail(3)).toBe('Notes linked to all of these chapters');
    const sources = new Set(['c1']);
    const created = new Set(['n1', 'n2']);
    expect(
      notesLinkSpan(
        [{ sectionIds: ['c1', 'n1', 'n2'] }, { sectionIds: ['other'] }],
        sources,
        created,
      ),
    ).toBe(3);
    expect(notesLinkSpan([{ sectionIds: ['c1', 'n1'] }], sources, created)).toBe(2);
  });
});
