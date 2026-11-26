/**
 * Right-click Split chapter uses the clicked paragraph (#383), not the caret
 * and not a text range that crosses into the next paragraph.
 */
import { describe, expect, it } from 'vitest';
import { undoDepth } from '@tiptap/pm/history';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { flushPromises, mount } from '@vue/test-utils';
import * as Y from 'yjs';
import { docToYDoc, writeStructure, yDocToDoc } from '@swarmdraft/docx';
import { addSection, firstLineText } from '@swarmdraft/editor';
import type { BlockNode, DocNode } from '@swarmdraft/schema';
import ManuscriptEditor from '../ManuscriptEditor.vue';
import { openSession, type ManuscriptSession } from '../manuscript-session';
import { runChapterBreakBatch, runChapterSplit, scanSessionBreaks } from './chapter-app-handlers';

const HEADING = '  Chapter 2  ';

function para(text: string): BlockNode {
  return {
    type: 'paragraph',
    attrs: { style: 'body' },
    content: text ? [{ type: 'text', text }] : [],
  };
}

function docOf(texts: readonly string[]): DocNode {
  return { type: 'doc', content: texts.map(para) };
}

function sessionAround(ydoc: Y.Doc): ManuscriptSession {
  let outline = addSection([], {
    manuscriptId: 'm',
    kind: 'chapter',
    title: 'One',
    id: 'c1',
  });
  const manuscript = new Y.Doc();
  writeStructure(
    manuscript,
    outline.map((s) => ({ ...s, docId: `manuscript/m/section/${s.id}` })),
  );
  outline = outline.map((s) => ({ ...s, docId: `manuscript/m/section/${s.id}` }));
  return openSession(
    'm',
    'A test manuscript',
    manuscript,
    new Map([[outline[0]!.docId, ydoc]]),
    null,
  );
}

function editorOf(w: ReturnType<typeof mount>): Editor {
  return (w.get('.tiptap').element as unknown as { editor: Editor }).editor;
}

function blockPos(doc: PMNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos;
}

/** Selection from inside one paragraph through a later one, so a text range would cross the boundary. */
function selectAcross(
  editor: Editor,
  fromBlock: number,
  fromOffset: number,
  toBlock: number,
  toOffset: number,
) {
  const from = blockPos(editor.state.doc, fromBlock) + 1 + fromOffset;
  const to = blockPos(editor.state.doc, toBlock) + 1 + toOffset;
  editor.commands.setTextSelection({ from, to });
}

function rawParagraphs(doc: Y.Doc | undefined): string[] {
  if (!doc) return [];
  return (yDocToDoc(doc).content ?? []).map((block) => {
    if (!('content' in block) || !block.content) return '';
    return block.content.map((n) => (n.type === 'text' ? n.text : '')).join('');
  });
}

async function mountChapter(texts: readonly string[]) {
  const ydoc = docToYDoc(docOf(texts));
  const w = mount(ManuscriptEditor, {
    props: {
      doc: ydoc,
      chapterOpsEnabled: true,
      canMergePrevChapter: true,
      chapterNumber: 1,
    },
    attachTo: document.body,
  });
  await flushPromises();
  return { w, ydoc, editor: editorOf(w), session: sessionAround(ydoc) };
}

function paragraphEl(w: ReturnType<typeof mount>, text: string) {
  const want = text.replace(/\s+/g, ' ').trim();
  const paras = w.findAll('.tiptap p');
  const found = paras.find((p) => p.text().replace(/\s+/g, ' ').trim() === want);
  if (!found) {
    throw new Error(
      `missing paragraph ${JSON.stringify(want)}; have ${JSON.stringify(paras.map((p) => p.text()))}`,
    );
  }
  return found;
}

async function rightClickSplit(w: ReturnType<typeof mount>, text: string) {
  await paragraphEl(w, text).trigger('contextmenu', { clientX: 24, clientY: 18 });
  await flushPromises();
  const item = w.get('[data-test="ctx-split_chapter"]');
  expect(item.attributes('aria-disabled')).toBeUndefined();
  await item.trigger('click');
  await flushPromises();
}

function titleInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('[data-test="split-chapter-title"]');
  if (!input) throw new Error('split popover did not open');
  return input;
}

function removeBox(): HTMLInputElement {
  const box = document.querySelector<HTMLInputElement>('[data-test="split-chapter-remove-line"]');
  if (!box) throw new Error('remove-line checkbox missing');
  return box;
}

async function submitSplit() {
  const form = document.querySelector<HTMLFormElement>('[data-test="split-chapter-popover"]');
  if (!form) throw new Error('split popover missing');
  form.requestSubmit();
  await flushPromises();
}

const MIDDLE = [
  'Paragraph one.',
  'Paragraph two.',
  'Paragraph three.',
  'About a sentence.',
  HEADING,
  'After the heading.',
] as const;

describe('right-click split chapter (#383)', () => {
  it('suggests only the clicked heading and splits at its start when remove is checked', async () => {
    const { w, editor, session } = await mountChapter(MIDDLE);
    // Caret and selection start two paragraphs before the heading and run
    // through it, which is the range that used to build the title.
    selectAcross(editor, 2, 4, 4, 4);
    const docBefore = editor.state.doc;
    const undoBefore = undoDepth(editor.state);
    const selectionFrom = editor.state.selection.from;

    await rightClickSplit(w, HEADING);

    expect(editor.state.doc.eq(docBefore)).toBe(true);
    expect(undoDepth(editor.state)).toBe(undoBefore);
    expect(editor.state.selection.from).toBe(selectionFrom);

    const input = titleInput();
    expect(input.value).toBe('Chapter 2');
    expect(input.value).not.toContain('About a sentence');
    expect(input.value).not.toContain('Paragraph three');
    expect(removeBox().checked).toBe(true);

    await submitSplit();
    const payload = w.emitted('split-chapter')?.[0]?.[0] as {
      blockIndex: number;
      title: string;
      removeLine: boolean;
    };
    expect(payload).toEqual({ blockIndex: 4, title: 'Chapter 2', removeLine: true });

    await runChapterSplit(session, 'm', 'c1', payload, 'c1');
    const [kept, created] = session.outline.value;
    expect(rawParagraphs(session.sections.get(kept!.docId))).toEqual([
      'Paragraph one.',
      'Paragraph two.',
      'Paragraph three.',
      'About a sentence.',
    ]);
    expect(created?.title).toBe('Chapter 2');
    expect(rawParagraphs(session.sections.get(created!.docId))).toEqual(['After the heading.']);
    expect(rawParagraphs(session.sections.get(created!.docId)).join('\n')).not.toContain(
      'Chapter 2',
    );
    w.unmount();
  });

  it('keeps the clicked line as the first paragraph when remove is unchecked', async () => {
    const { w, editor, session } = await mountChapter(MIDDLE);
    selectAcross(editor, 2, 4, 4, 4);
    await rightClickSplit(w, HEADING);
    expect(titleInput().value).toBe('Chapter 2');
    removeBox().click();
    await flushPromises();
    expect(removeBox().checked).toBe(false);

    await submitSplit();
    const payload = w.emitted('split-chapter')?.[0]?.[0] as {
      blockIndex: number;
      title: string;
      removeLine: boolean;
    };
    expect(payload).toEqual({ blockIndex: 4, title: 'Chapter 2', removeLine: false });
    await runChapterSplit(session, 'm', 'c1', payload, 'c1');
    const [kept, created] = session.outline.value;
    expect(rawParagraphs(session.sections.get(kept!.docId))).toEqual([
      'Paragraph one.',
      'Paragraph two.',
      'Paragraph three.',
      'About a sentence.',
    ]);
    expect(rawParagraphs(session.sections.get(created!.docId))).toEqual([
      HEADING,
      'After the heading.',
    ]);
    w.unmount();
  });

  it('suggests a clicked body paragraph exactly, with none of the next line', async () => {
    const { w, editor } = await mountChapter(MIDDLE);
    selectAcross(editor, 2, 10, 3, 8);
    await rightClickSplit(w, 'About a sentence.');
    expect(titleInput().value).toBe('About a sentence.');
    expect(titleInput().value).not.toContain('Chapter');
    expect(titleInput().value).not.toContain('Paragraph three');
    expect(removeBox().checked).toBe(false);
    w.unmount();
  });

  it('does not split when the clicked heading is the first paragraph', async () => {
    const texts = ['Chapter 2', 'Paragraph two.', 'Paragraph three.'];
    const { w, editor } = await mountChapter(texts);
    // Caret sits in a later paragraph, which used to enable Split at the wrong line.
    selectAcross(editor, 2, 0, 2, 4);
    await paragraphEl(w, 'Chapter 2').trigger('contextmenu', { clientX: 20, clientY: 16 });
    await flushPromises();
    const item = w.get('[data-test="ctx-split_chapter"]');
    expect(item.attributes('aria-disabled')).toBe('true');
    expect(item.text()).toContain('Already the start of a chapter');
    await item.trigger('click');
    await flushPromises();
    expect(w.emitted('split-chapter')).toBeUndefined();
    expect(document.querySelector('[data-test="split-chapter-popover"]')).toBeNull();
    expect(firstLineText(editor.state.doc.toJSON().content?.[0] as BlockNode)).toBe('Chapter 2');
    w.unmount();
  });

  it('splits a heading that is the last paragraph, ahead of a caret at the chapter start', async () => {
    const texts = ['Paragraph one.', 'Paragraph two.', 'Paragraph three.', HEADING];
    const { w, editor, session } = await mountChapter(texts);
    expect(editor.state.selection.$from.index(0)).toBe(0);
    await rightClickSplit(w, HEADING);
    expect(titleInput().value).toBe('Chapter 2');
    expect(removeBox().checked).toBe(true);
    await submitSplit();
    const payload = w.emitted('split-chapter')?.[0]?.[0] as {
      blockIndex: number;
      title: string;
      removeLine: boolean;
    };
    expect(payload.blockIndex).toBe(3);
    expect(payload.removeLine).toBe(true);
    await runChapterSplit(session, 'm', 'c1', payload, 'c1');
    const [kept, created] = session.outline.value;
    expect(rawParagraphs(session.sections.get(kept!.docId))).toEqual([
      'Paragraph one.',
      'Paragraph two.',
      'Paragraph three.',
    ]);
    expect(created?.title).toBe('Chapter 2');
    expect(rawParagraphs(session.sections.get(created!.docId))).toEqual(['']);
    w.unmount();
  });

  it('keeps the last paragraph when remove is unchecked', async () => {
    const texts = ['Paragraph one.', 'Paragraph two.', 'Paragraph three.', 'Chapter 2'];
    const { w, session } = await mountChapter(texts);
    await rightClickSplit(w, 'Chapter 2');
    removeBox().click();
    await flushPromises();
    expect(removeBox().checked).toBe(false);
    await submitSplit();
    const payload = w.emitted('split-chapter')?.[0]?.[0] as {
      blockIndex: number;
      title: string;
      removeLine: boolean;
    };
    expect(payload).toEqual({ blockIndex: 3, title: 'Chapter 2', removeLine: false });
    await runChapterSplit(session, 'm', 'c1', payload, 'c1');
    const [kept, created] = session.outline.value;
    expect(rawParagraphs(session.sections.get(kept!.docId))).toEqual([
      'Paragraph one.',
      'Paragraph two.',
      'Paragraph three.',
    ]);
    expect(rawParagraphs(session.sections.get(created!.docId))).toEqual(['Chapter 2']);
    w.unmount();
  });

  it('keyboard split still uses the caret paragraph', async () => {
    const { w, editor } = await mountChapter(MIDDLE);
    selectAcross(editor, 3, 0, 3, 0);
    expect(editor.state.selection.$from.index(0)).toBe(3);
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, shiftKey: true, bubbles: true }),
    );
    await flushPromises();
    expect(titleInput().value).toBe('About a sentence.');
    expect(removeBox().checked).toBe(false);
    w.unmount();
  });
});

describe('find chapter breaks still split at the heading (#305)', () => {
  it('splits after three paragraphs at the heading line, not earlier', async () => {
    const ydoc = docToYDoc(
      docOf([
        'Paragraph one.',
        'Paragraph two.',
        'Paragraph three.',
        'Chapter 2',
        'After the heading.',
      ]),
    );
    const session = sessionAround(ydoc);
    const rows = scanSessionBreaks(session);
    expect(rows.map((row) => ({ title: row.title, blockIndex: row.blockIndex }))).toEqual([
      { title: 'Chapter 2', blockIndex: 3 },
    ]);
    expect(rows[0]?.removeLine).toBe(true);
    const result = await runChapterBreakBatch(session, 'm', rows, 'c1');
    expect(result.skippedKeys).toEqual([]);
    const [kept, created] = session.outline.value;
    expect(rawParagraphs(session.sections.get(kept!.docId))).toEqual([
      'Paragraph one.',
      'Paragraph two.',
      'Paragraph three.',
    ]);
    expect(created?.title).toBe('Chapter 2');
    expect(rawParagraphs(session.sections.get(created!.docId))).toEqual(['After the heading.']);
  });
});
