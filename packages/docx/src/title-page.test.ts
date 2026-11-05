import { describe, expect, it } from 'vitest';
import {
  displayTitleFromManuscriptLine,
  headingsMatch,
  parseTitlePageMeta,
  titlePageOpeningEnd,
} from './title-page';

describe('title page (#235)', () => {
  it('reads centered all-caps title, not contact block', () => {
    const meta = parseTitlePageMeta([
      { text: 'Brett Humphreys', centered: false, maxSize: 24, allBold: false, indLeft: 0 },
      { text: '12,000 words', centered: false, maxSize: 24, allBold: false, indLeft: 7200 },
      { text: 'MEMORY WIPE', centered: true, maxSize: 32, allBold: true, indLeft: 0 },
      { text: 'by Brett Humphreys', centered: true, maxSize: 24, allBold: false, indLeft: 0 },
    ]);
    expect(meta.title).toBe('Memory Wipe');
    expect(meta.author).toBe('Brett Humphreys');
  });

  it('title-cases short all-caps lines only', () => {
    expect(displayTitleFromManuscriptLine('MEMORY WIPE')).toBe('Memory Wipe');
    expect(displayTitleFromManuscriptLine('THE LANTERNS OF HOLLOW REACH')).toBe(
      'THE LANTERNS OF HOLLOW REACH',
    );
  });

  it('matches chapter headings case-insensitively', () => {
    expect(headingsMatch('Chapter One', 'CHAPTER ONE')).toBe(true);
  });

  it('titlePageOpeningEnd stops at first body paragraph (#309)', () => {
    const paras = [
      { text: 'TITLE', centered: true, maxSize: 32, allBold: true, indLeft: 0 },
      { text: 'by Name', centered: true, maxSize: 24, allBold: false, indLeft: 0 },
      {
        text: 'First chapter prose starts here with a long enough sentence to count as body.',
        centered: false,
        maxSize: 24,
        allBold: false,
        indLeft: 0,
      },
    ];
    expect(titlePageOpeningEnd(paras)).toBe(2);
  });
});
