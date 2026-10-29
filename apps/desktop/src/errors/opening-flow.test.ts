import { describe, expect, it } from 'vitest';
import { errorCardIcon, openingStateFromEvent, titleFromDocxName } from './opening-flow';

describe('opening-flow (#80)', () => {
  it('maps backend progress into ob6 props', () => {
    expect(
      openingStateFromEvent(null, {
        stage: 'loading',
        percent: 45,
        title: 'Harbor',
        chaptersFound: 7,
      }),
    ).toEqual({ title: 'Harbor', found: 7, progress: 0.45 });
  });

  it('keeps the working title when the backend sends an empty one', () => {
    expect(
      openingStateFromEvent(
        { title: 'Draft', found: 0, progress: 0 },
        { stage: 'saving', percent: 10, title: '', chaptersFound: 2 },
      ).title,
    ).toBe('Draft');
  });

  it('derives a book title from the file name', () => {
    expect(titleFromDocxName('My Book.docx')).toBe('My Book');
  });

  it('picks icons for mapped error codes', () => {
    expect(errorCardIcon('file-locked')).toBe('lock');
    expect(errorCardIcon('disk-full')).toBe('disk');
    expect(errorCardIcon('file-damaged')).toBe('alert');
  });
});
