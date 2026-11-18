import { describe, expect, it } from 'vitest';
import type { BlockNode, DocNode } from '@swarmdraft/schema';
import { scanChapterBreaks, type BreakScanChapter } from './chapter-breaks';

function para(text: string, style: 'body' | 'centered' = 'body'): BlockNode {
  return {
    type: 'paragraph',
    attrs: { style },
    content: text ? [{ type: 'text', text }] : [],
  };
}

function blank(): BlockNode {
  return { type: 'paragraph', attrs: { style: 'body' } };
}

function chapter(id: string, chapterIndex: number, blocks: BlockNode[]): BreakScanChapter {
  const doc: DocNode = { type: 'doc', content: blocks };
  return { id, title: 'One', chapterIndex, doc };
}

describe('scan chapter breaks (#305)', () => {
  it('finds numbered headings, ornaments, and short titles, and skips the first paragraph', () => {
    const found = scanChapterBreaks([
      chapter('c1', 0, [
        para('Chapter One'),
        para('She walked down the lane and did not stop.'),
        para('Yes.'),
        para('No'),
        para('***'),
        para('The next line of the scene stayed in the chapter.'),
        blank(),
        para('The Harbor'),
        blank(),
        para('Chapter Two'),
        para('Morning came in quietly over the field.'),
        para('12'),
        para('I'),
        para('II'),
        para('Ch. 3'),
        para('Part Two'),
        para('Book Three'),
        para('CHAPTER ONE'),
        para('# Chapter 4'),
        para('**Part II**'),
        para('• • •'),
        para('---'),
        para('**'),
        para('She said no.'),
      ]),
    ]);
    expect(found.map((row) => row.title)).toEqual([
      'Chapter 2',
      'The Harbor',
      'Chapter Two',
      '12',
      'II',
      'Ch. 3',
      'Part Two',
      'Book Three',
      'CHAPTER ONE',
      'Chapter 4',
      'Part II',
      'Chapter 13',
      'Chapter 14',
    ]);
    expect(found.map((row) => row.kind)).toEqual([
      'ornament',
      'title',
      'numbered',
      'numbered',
      'numbered',
      'numbered',
      'numbered',
      'numbered',
      'numbered',
      'numbered',
      'numbered',
      'ornament',
      'ornament',
    ]);
    expect(found[0]).toMatchObject({
      removeLine: false,
      snippet: 'The next line of the scene stayed in the chapter.',
      sourceTitle: 'One',
      blockIndex: 4,
    });
    expect(found.find((row) => row.title === 'The Harbor')).toMatchObject({ removeLine: true });
    expect(found.find((row) => row.title === 'Chapter Two')).toMatchObject({ removeLine: true });
    expect(found.some((row) => row.blockIndex === 0)).toBe(false);
  });

  it('does not flag short body lines, dialogue, or a one-letter roman numeral', () => {
    const found = scanChapterBreaks([
      chapter('c1', 0, [
        para('Opening line.'),
        para('She walked down the lane and did not stop.'),
        para('Chapter 12 was the night she left the house.'),
        para('Yes.'),
        para('OK'),
        blank(),
        para('"Go home."'),
        blank(),
        para('and then'),
        para('She ran.'),
        para('I'),
        para('Wait'),
        {
          type: 'paragraph',
          attrs: { style: 'centered' },
          content: [{ type: 'text', text: 'She ran.' }],
        },
      ]),
    ]);
    expect(found).toEqual([]);
  });

  it('accepts a centered short line and a title between blank paragraphs', () => {
    const found = scanChapterBreaks([
      chapter('c1', 0, [
        para('Opening line.'),
        para('Salt wind', 'centered'),
        blank(),
        para('The Old Road'),
        blank(),
        para('Then he left'),
      ]),
    ]);
    expect(found.map((row) => row.title)).toEqual(['Salt wind', 'The Old Road']);
    expect(found.every((row) => row.removeLine)).toBe(true);
  });

  it('numbers an ornament from the chapter it would become', () => {
    const found = scanChapterBreaks([
      chapter('c1', 0, [para('Opening line.'), para('***'), para('After the mark.')]),
      chapter('c2', 1, [para('Second opening.'), para('---'), para('Later.')]),
    ]);
    expect(found.map((row) => [row.chapterId, row.title])).toEqual([
      ['c1', 'Chapter 2'],
      ['c2', 'Chapter 4'],
    ]);
  });

  it('keeps one row when a line could match more than one rule', () => {
    const found = scanChapterBreaks([
      chapter('c1', 0, [para('Opening line.'), para('Chapter 12')]),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'numbered', title: 'Chapter 12' });
  });
});
