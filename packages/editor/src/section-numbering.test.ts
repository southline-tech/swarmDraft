import { describe, expect, it } from 'vitest';
import { addSection } from './outline';
import {
  sectionDisplayHeading,
  sectionNumberLabel,
  sectionNumberLabels,
} from './section-numbering';

describe('sectionNumberLabel', () => {
  it('formats the four chapter styles', () => {
    expect(sectionNumberLabel('chapter', 3, 'chapter_arabic')).toBe('Chapter 3');
    expect(sectionNumberLabel('chapter', 3, 'chapter_words')).toBe('Chapter Three');
    expect(sectionNumberLabel('chapter', 3, 'chapter_upper')).toBe('THREE');
    expect(sectionNumberLabel('chapter', 3, 'number_only')).toBe('3');
  });

  it('numbers parts separately', () => {
    expect(sectionNumberLabel('part', 2, 'chapter_words')).toBe('Part Two');
    expect(sectionNumberLabel('part', 2, 'chapter_arabic')).toBe('Part II');
  });
});

describe('sectionNumberLabels', () => {
  it('skips front and back matter and renumbers on reorder', () => {
    let s = addSection([], { manuscriptId: 'm', id: 'f', kind: 'front_matter', title: 'Title' });
    s = addSection(s, { manuscriptId: 'm', id: 'p', kind: 'part', title: 'P' });
    s = addSection(s, {
      manuscriptId: 'm',
      id: 'c1',
      kind: 'chapter',
      title: 'A',
      parentId: 'p',
    });
    s = addSection(s, { manuscriptId: 'm', id: 'c2', kind: 'chapter', title: 'B' });
    s = addSection(s, { manuscriptId: 'm', id: 'b', kind: 'back_matter', title: 'End' });

    const labels = sectionNumberLabels(s, 'chapter_arabic');
    expect(labels.get('f')).toBeUndefined();
    expect(labels.get('p')).toBe('Part I');
    expect(labels.get('c1')).toBe('Chapter 1');
    expect(labels.get('c2')).toBe('Chapter 2');
    expect(labels.get('b')).toBeUndefined();
  });

  it('renumbers chapters when outline order changes', () => {
    let s = addSection([], { manuscriptId: 'm', id: 'a', kind: 'chapter', title: 'A' });
    s = addSection(s, { manuscriptId: 'm', id: 'b', kind: 'chapter', title: 'B' });
    expect(sectionNumberLabels(s, 'chapter_arabic').get('a')).toBe('Chapter 1');
    const swapped = [s[1]!, s[0]!];
    expect(sectionNumberLabels(swapped, 'chapter_arabic').get('b')).toBe('Chapter 1');
    expect(sectionNumberLabels(swapped, 'chapter_arabic').get('a')).toBe('Chapter 2');
  });
});

describe('sectionDisplayHeading', () => {
  it('joins label and optional title', () => {
    expect(sectionDisplayHeading('Chapter 1', 'Low Tide')).toBe('Chapter 1: Low Tide');
    expect(sectionDisplayHeading('Chapter 1', '')).toBe('Chapter 1');
    expect(sectionDisplayHeading('', 'Only title')).toBe('Only title');
  });
});
