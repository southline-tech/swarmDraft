import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import * as Y from 'yjs';
import { docToYDoc } from '@coauthor/docx';
import StatusBar from './StatusBar.vue';
import ManuscriptEditor from '../ManuscriptEditor.vue';
import { SAMPLE_DOC } from '../fixtures/sample';
import {
  bookWordCount,
  countWords,
  docWordCount,
  sectionTreeDocs,
  watchBookWords,
} from './wordcount';

const para = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('countWords', () => {
  it('counts words, keeping contractions and hyphenated words whole', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   * * *  ')).toBe(0);
    expect(countWords("Don't stop the well-worn tide, Wren.")).toBe(6);
    expect(countWords('Twelve iron rings — eleven ropes')).toBe(5);
    expect(countWords('café naïve 1907')).toBe(3);
  });

  it('keeps combining marks inside words', () => {
    expect(countWords('nai\u0308ve cafe\u0301')).toBe(2);
    expect(countWords('नमस्ते दुनिया')).toBe(2);
  });

  it('counts a number with a decimal point or thousands separator as one word', () => {
    expect(countWords('3.5')).toBe(1);
    expect(countWords('1,000')).toBe(1);
    expect(countWords('It cost 1,000 coins, or 3.5 each.')).toBe(7);
    expect(countWords('one,two. three')).toBe(3);
  });
});

describe('Y.Doc counts', () => {
  it('counts a section doc and the whole book', () => {
    const a = docToYDoc(para('The tide went out.') as never);
    const b = docToYDoc(para('Gulls worked the mud.') as never);
    expect(docWordCount(a)).toBe(4);
    expect(bookWordCount([a, b])).toBe(8);
    expect(docWordCount(new Y.Doc())).toBe(0);
  });

  it('collects a chapter and its scenes, not its siblings', () => {
    const d = (t: string) => docToYDoc(para(t) as never);
    const docs = new Map([
      ['p', d('Part')],
      ['c1', d('Chapter one')],
      ['s1', d('Scene one text here')],
      ['c2', d('Chapter two')],
    ]);
    const outline = [
      { id: 'P', kind: 'part', title: 'Part', docId: 'p' },
      { id: 'C1', kind: 'chapter', title: 'One', parentId: 'P', docId: 'c1' },
      { id: 'S1', kind: 'scene', title: 'S', parentId: 'C1', docId: 's1' },
      { id: 'C2', kind: 'chapter', title: 'Two', parentId: 'P', docId: 'c2' },
    ] as never;
    expect(bookWordCount(sectionTreeDocs(outline, 'C1', docs))).toBe(6);
    expect(sectionTreeDocs(outline, undefined, docs)).toEqual([]);
  });

  it('recounts only the section that changed, keeping the cached totals of the others', () => {
    vi.useFakeTimers();
    const a = docToYDoc(para('One two') as never);
    const b = docToYDoc(para('Three four five') as never);
    const seen: number[] = [];
    const stop = watchBookWords([a, b], (n) => seen.push(n), 100);
    expect(seen).toEqual([5]);
    const readB = vi.spyOn(b, 'getXmlFragment');
    const text = (a.getXmlFragment('prosemirror').get(0) as Y.XmlElement).get(0) as Y.XmlText;
    text.insert(7, ' more');
    vi.advanceTimersByTime(100);
    expect(seen).toEqual([5, 6]);
    expect(readB).not.toHaveBeenCalled();
    stop();
    vi.useRealTimers();
  });

  it('recounts the book after edits, debounced', () => {
    vi.useFakeTimers();
    const a = docToYDoc(para('One two') as never);
    const seen: number[] = [];
    const stop = watchBookWords([a], (n) => seen.push(n), 100);
    expect(seen).toEqual([2]);
    const text = (a.getXmlFragment('prosemirror').get(0) as Y.XmlElement).get(0) as Y.XmlText;
    text.insert(7, ' three');
    text.insert(13, ' four');
    expect(seen).toEqual([2]);
    vi.advanceTimersByTime(100);
    expect(seen).toEqual([2, 4]);
    stop();
    text.insert(0, 'zero ');
    vi.advanceTimersByTime(200);
    expect(seen).toEqual([2, 4]);
    vi.useRealTimers();
  });
});

describe('StatusBar', () => {
  it('shows chapter, counts and zoom, spanning the window on the surface token', () => {
    const w = mount(StatusBar, {
      props: { zoom: 100, chapterTitle: 'The Low Tide', chapterWords: 2154, bookWords: 16076 },
    });
    const bar = w.find('[data-test="status-bar"]');
    expect(bar.classes()).toEqual(
      expect.arrayContaining(['fixed', 'inset-x-0', 'box-border', 'bg-surface']),
    );
    expect(w.find('[data-test="status-chapter"]').text()).toBe('The Low Tide');
    expect(w.find('[data-test="status-chapter-words"]').text()).toBe('2,154 words in chapter');
    expect(w.find('[data-test="status-book-words"]').text()).toBe('16,076 words in book');
    expect(w.find('[data-test="zoom"]').exists()).toBe(true);
    expect(w.find('[data-test="status-selection-words"]').exists()).toBe(false);
  });

  it('leaves out items without data instead of faking them', () => {
    const w = mount(StatusBar, { props: { zoom: 100 } });
    for (const t of ['chapter', 'chapter-words', 'book-words', 'selection-words']) {
      expect(w.find(`[data-test="status-${t}"]`).exists()).toBe(false);
    }
    expect(w.find('[data-test="status-save"]').text()).toBe('');
    expect(w.find('[data-test="zoom"]').exists()).toBe(true);
  });

  it('announces save status politely, with the warning state explained', () => {
    const w = mount(StatusBar, { props: { zoom: 100, saveState: 'offline' } });
    const live = w.find('[data-test="status-save"]');
    expect(live.attributes('aria-live')).toBe('polite');
    const s = live.find('[data-state="offline"]');
    expect(s.classes()).toContain('text-warning');
    expect(s.attributes('title')).toMatch(/kept/);
  });

  it('shows the selection word count', () => {
    const w = mount(StatusBar, { props: { zoom: 100, selectionWords: 3 } });
    expect(w.find('[data-test="status-selection-words"]').text()).toBe('3 words selected');
  });

  it('uses the singular for one word', () => {
    const w = mount(StatusBar, {
      props: { zoom: 100, chapterWords: 1, selectionWords: 1, bookWords: 1 },
    });
    expect(w.find('[data-test="status-chapter-words"]').text()).toBe('1 word in chapter');
    expect(w.find('[data-test="status-selection-words"]').text()).toBe('1 word selected');
    expect(w.find('[data-test="status-book-words"]').text()).toBe('1 word in book');
  });

  it('keeps spacing on the --ct scale (space-5 between items, space-4 padding)', () => {
    const bar = mount(StatusBar, { props: { zoom: 100 } }).find('[data-test="status-bar"]');
    expect(bar.classes()).toEqual(expect.arrayContaining(['gap-5', 'px-4']));
  });

  it('updates zoom through the existing ZoomControl', async () => {
    const w = mount(StatusBar, {
      props: { zoom: 100, 'onUpdate:zoom': (z: number) => w.setProps({ zoom: z }) },
    });
    await w.find('[data-test="zoom-in"]').trigger('click');
    expect(w.props('zoom')).toBe(110);
  });
});

describe('ManuscriptEditor status bar', () => {
  it('counts the chapter and the selection, and passes through the chapter title', async () => {
    const w = mount(ManuscriptEditor, {
      props: { content: SAMPLE_DOC, chapterTitle: 'Chapter One' },
      attachTo: document.body,
    });
    await flushPromises();
    expect(w.find('[data-test="status-chapter"]').text()).toBe('Chapter One');
    const n = Number(
      w.find('[data-test="status-chapter-words"]').text().split(' ')[0]!.replace(/,/g, ''),
    );
    expect(n).toBeGreaterThan(0);
    // No book docs and no save state given: those items are left out.
    expect(w.find('[data-test="status-book-words"]').exists()).toBe(false);
    expect(w.find('[data-test="status-save"]').text()).toBe('');
    w.unmount();
  });

  it('shows the live book count from the section docs', async () => {
    const docs = new Map([
      ['a', docToYDoc(para('One two three') as never)],
      ['b', docToYDoc(para('Four five') as never)],
    ]);
    const w = mount(ManuscriptEditor, {
      props: { doc: docs.get('a'), bookDocs: docs },
      attachTo: document.body,
    });
    await flushPromises();
    expect(w.find('[data-test="status-book-words"]').text()).toBe('5 words in book');
    expect(w.find('[data-test="status-chapter-words"]').text()).toBe('3 words in chapter');
    await w.setProps({ chapterDocs: [...docs.values()] });
    await flushPromises();
    expect(w.find('[data-test="status-chapter-words"]').text()).toBe('5 words in chapter');
    w.unmount();
  });
});
