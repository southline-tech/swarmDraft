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

  it('collects a chapter doc, not its siblings', () => {
    const d = (t: string) => docToYDoc(para(t) as never);
    const docs = new Map([
      ['p', d('Part')],
      ['c1', d('Chapter one')],
      ['c2', d('Chapter two')],
    ]);
    const outline = [
      { id: 'P', kind: 'part', title: 'Part', docId: 'p' },
      { id: 'C1', kind: 'chapter', title: 'One', parentId: 'P', docId: 'c1' },
      { id: 'C2', kind: 'chapter', title: 'Two', parentId: 'P', docId: 'c2' },
    ] as never;
    expect(bookWordCount(sectionTreeDocs(outline, 'C1', docs))).toBe(2);
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
  it('is a 26px in-flow bar with three segments (#207)', () => {
    const w = mount(StatusBar, {
      props: {
        chapterCount: 12,
        showChapterSegment: true,
        columnTracks: '18rem 1fr',
        wordCount: 2154,
        wordsBeforeCaretInBook: 500,
        trackChanges: false,
        storyNotesPanelId: 'story-notes-panel',
      },
    });
    const bar = w.find('[data-test="status-bar"]');
    expect(bar.classes()).toContain('status-bar');
    expect(bar.attributes('role')).toBe('contentinfo');
    expect(w.find('[data-test="status-seg-left"]').text()).toContain('12 chapters');
    expect(w.find('[data-test="status-word-count"]').text()).toBe('2,154 words');
    expect(w.find('[data-test="status-page"]').text()).toBe('Page 2 of 9');
    expect(w.find('[data-test="status-track-changes"]').text()).toBe('Track changes: Off');
    expect(w.find('[data-test="status-notes-toggle"]').text()).toBe('Story notes');
  });

  it('shows selection and track on, with save and notes pressed state', () => {
    const w = mount(StatusBar, {
      props: {
        chapterCount: 1,
        showChapterSegment: true,
        columnTracks: '18rem 1fr',
        wordCount: 100,
        selectionWords: 3,
        wordsBeforeCaretInBook: 0,
        trackChanges: true,
        storyNotesOpen: true,
        storyNotesPanelId: 'story-notes-panel',
        save: { phase: 'saved', savedAt: Date.now() },
      },
    });
    expect(w.find('[data-test="status-word-count"]').text()).toBe('100 words · 3 selected');
    expect(w.find('[data-test="status-track-changes"]').text()).toBe('Track changes: On');
    expect(w.find('[data-test="status-save"]').attributes('data-state')).toBe('saved');
    expect(w.find('[data-test="status-notes-toggle"]').attributes('aria-pressed')).toBe('true');
  });

  it('announces save status politely; word count is not live', () => {
    const w = mount(StatusBar, {
      props: {
        chapterCount: 1,
        showChapterSegment: true,
        wordCount: 1,
        wordsBeforeCaretInBook: 0,
        save: { phase: 'saving' },
        storyNotesPanelId: 'story-notes-panel',
      },
    });
    const live = w.find('[data-test="status-save"]');
    expect(live.attributes('aria-live')).toBe('polite');
    expect(w.find('[data-test="status-word-count"]').attributes('aria-live')).toBeUndefined();
    expect(live.text()).toContain('Saving…');
  });

  it('shows ap5 error copy with bordered Retry', async () => {
    const w = mount(StatusBar, {
      props: {
        wordCount: 1,
        wordsBeforeCaretInBook: 0,
        save: { phase: 'error', message: 'mapError title' },
        storyNotesPanelId: 'story-notes-panel',
      },
    });
    expect(w.find('[data-test="status-save"]').text()).toContain("Couldn't save. Retrying…");
    expect(w.find('[data-test="status-save-retry"]').classes()).toContain('status-bar__retry');
    await w.find('[data-test="status-save-retry"]').trigger('click');
    expect(w.emitted('save-retry')).toHaveLength(1);
  });

  it('leaves out word count when unknown', () => {
    const w = mount(StatusBar, { props: { storyNotesPanelId: 'story-notes-panel' } });
    expect(w.find('[data-test="status-word-count"]').exists()).toBe(false);
    expect(w.find('[data-test="status-save"]').exists()).toBe(false);
  });

  it('uses the singular for one word selected', () => {
    const w = mount(StatusBar, {
      props: {
        wordCount: 1,
        selectionWords: 1,
        wordsBeforeCaretInBook: 0,
        storyNotesPanelId: 'story-notes-panel',
      },
    });
    expect(w.find('[data-test="status-word-count"]').text()).toBe('1 word · 1 selected');
  });

  it('toggles story notes from the footer', async () => {
    const w = mount(StatusBar, {
      props: { trackChanges: false, storyNotesPanelId: 'story-notes-panel' },
    });
    expect(w.find('[data-test="status-track-changes"]').attributes('role')).toBeUndefined();
    await w.find('[data-test="status-notes-toggle"]').trigger('click');
    expect(w.emitted('toggle-story-notes')).toHaveLength(1);
  });

  it('shows zoom at the center segment end (#204)', async () => {
    const w = mount(StatusBar, {
      props: {
        wordCount: 10,
        wordsBeforeCaretInBook: 0,
        storyNotesPanelId: 'story-notes-panel',
        zoom: 100,
        'onUpdate:zoom': (v: number) => w.setProps({ zoom: v }),
      },
    });
    expect(w.find('[data-test="status-zoom"]').attributes('aria-label')).toBe('Zoom');
    expect(w.find('[data-test="status-zoom-reset"]').text()).toBe('100%');
    await w.find('[data-test="status-zoom-in"]').trigger('click');
    expect(w.emitted('update:zoom')).toEqual([[110]]);
  });
});

describe('ManuscriptEditor status bar', () => {
  it('counts words for the open doc and passes selection', async () => {
    const w = mount(ManuscriptEditor, {
      props: { content: SAMPLE_DOC, chapterTitle: 'Chapter One' },
      attachTo: document.body,
    });
    await flushPromises();
    const n = Number(
      w.find('[data-test="status-word-count"]').text().split(' ')[0]!.replace(/,/g, ''),
    );
    expect(n).toBeGreaterThan(0);
    expect(w.find('[data-test="status-save"]').exists()).toBe(false);
    w.unmount();
  });

  it('shows the live book count from the section docs', async () => {
    const docs = new Map([
      ['a', docToYDoc(para('One two three') as never)],
      ['b', docToYDoc(para('Four five') as never)],
    ]);
    const w = mount(ManuscriptEditor, {
      props: { doc: docs.get('a'), bookDocs: [...docs.values()] },
      attachTo: document.body,
    });
    await flushPromises();
    expect(w.find('[data-test="status-word-count"]').text()).toBe('5 words');
    await w.setProps({ chapterDocs: [...docs.values()] });
    await flushPromises();
    expect(w.find('[data-test="status-word-count"]').text()).toBe('5 words');
    w.unmount();
  });
});
