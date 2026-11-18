/**
 * #305 review: one batch at a time, chapter-toast Ctrl+Z only on the manuscript,
 * and Show leaves the line beside the preview card.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import * as Y from 'yjs';
import { docToYDoc, writeStructure } from '@swarmdraft/docx';
import { addSection } from '@swarmdraft/editor';
import type { BlockNode, DocNode } from '@swarmdraft/schema';
import App from './App.vue';
import { openSession, type ManuscriptSession } from './manuscript-session';
import NoteBodyEditor from './notes/NoteBodyEditor.vue';
import { addNote, createNotesDoc } from './notes/doc';

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isTauri: () => true,
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setTitle: vi.fn(async () => {}) }),
}));
vi.mock('./backend', async (importOriginal) => {
  const real = await importOriginal<typeof import('./backend')>();
  return {
    ...real,
    getAppInfo: async () => null,
    getRecoveryNotices: async () => [],
    getMigrationNotices: async () => [],
    openLatestManuscript: async () => null,
    peekResumeManuscript: async () => null,
    listenOpeningProgress: async () => () => {},
    listenOpenDraftPath: async () => () => {},
    draftTakeLaunchPath: async () => null,
    spellLintParagraph: async () => [],
    sectionReviewMeta: async () => ({
      comments: [],
      authorSavedNames: {},
      suggestionReasons: {},
    }),
  };
});
vi.mock('./close-flush', () => ({
  CLOSE_FLUSH_TIMEOUT_MS: 3000,
  flushOnClose: async () => () => {},
  flushWithTimeout: async () => 'saved',
  confirmQuit: async () => true,
}));

function para(text: string): BlockNode {
  return { type: 'paragraph', attrs: { style: 'body' }, content: [{ type: 'text', text }] };
}

function docOf(blocks: BlockNode[]): DocNode {
  return { type: 'doc', content: blocks };
}

function sessionWith(blocks: BlockNode[]): ManuscriptSession {
  let outline = addSection([], { manuscriptId: 'm', kind: 'chapter', title: 'One', id: 'c1' });
  const manuscript = new Y.Doc();
  writeStructure(
    manuscript,
    outline.map((s) => ({ ...s, docId: `manuscript/m/section/${s.id}` })),
  );
  outline = outline.map((s) => ({ ...s, docId: `manuscript/m/section/${s.id}` }));
  const sections = new Map([[outline[0]!.docId, docToYDoc(docOf(blocks))]]);
  return openSession('m', 'A test manuscript', manuscript, sections, null);
}

const TWO_BREAKS = [
  para('Opening line.'),
  para('Chapter Two'),
  para('A quiet morning on the road.'),
  para('Chapter Three'),
  para('Later the rain started.'),
];

const settle = async () => {
  await flushPromises();
  await flushPromises();
};

function ctrlZ(target: Element, repeat = false) {
  const event = new KeyboardEvent('keydown', {
    key: 'z',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    repeat,
  });
  target.dispatchEvent(event);
  return event;
}

describe('Find chapter breaks review (#305)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn();
        disconnect = vi.fn();
        unobserve = vi.fn();
      },
    );
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function withBook(blocks: BlockNode[]) {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const session = sessionWith(blocks);
    (w.vm as unknown as { open: (s: ManuscriptSession) => void }).open(session);
    await settle();
    return { w, session };
  }

  async function openFindBreaks(w: ReturnType<typeof mount>) {
    await w.get('[data-test="section-c1"]').trigger('contextmenu', { clientX: 40, clientY: 80 });
    await settle();
    const item = document.body.querySelector(
      '[data-test="outline-ctx-find-breaks"]',
    ) as HTMLElement;
    expect(item).toBeTruthy();
    item.click();
    await settle();
    expect(document.querySelector('[data-test="find-breaks-dialog"]')).toBeTruthy();
  }

  it('does not start a second batch while the first save is still running', async () => {
    const { w, session } = await withBook(TWO_BREAKS);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const realSave = session.save.bind(session);
    session.save = async (next) => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (calls === 1) await hold;
        return await realSave(next);
      } finally {
        inFlight -= 1;
      }
    };
    await openFindBreaks(w);
    const confirm = document.querySelector('[data-test="find-breaks-confirm"]') as HTMLElement;
    expect(confirm).toBeTruthy();
    const first = confirm.click();
    const second = confirm.click();
    expect(calls).toBe(1);
    expect(maxInFlight).toBe(1);
    release();
    await first;
    await second;
    await settle();
    expect(session.outline.value).toHaveLength(3);
    expect(maxInFlight).toBe(1);
    expect(calls).toBe(2);
    w.unmount();
  });

  it('takes Ctrl+Z only on the manuscript, and only once', async () => {
    const { w, session } = await withBook(TWO_BREAKS);
    await openFindBreaks(w);
    (document.querySelector('[data-test="find-breaks-confirm"]') as HTMLElement).click();
    await settle();
    expect(session.outline.value).toHaveLength(3);
    expect(document.querySelector('[data-test="find-breaks-dialog"]')).toBeNull();

    await openFindBreaks(w);
    const notes = createNotesDoc();
    const note = addNote(notes, { kind: 'human', id: 'you', name: 'You' }, 'A note');
    const noteMount = mount(NoteBodyEditor, {
      props: { notesDoc: notes, noteId: note.id },
      attachTo: document.body,
    });
    await settle();
    const noteBody = noteMount.get('[data-test="note-body"]').element;
    const inNote = ctrlZ(noteBody);
    expect(inNote.defaultPrevented).toBe(false);
    expect(session.outline.value).toHaveLength(3);
    expect(document.querySelector('[data-test="find-breaks-dialog"]')).toBeTruthy();

    const dialogBtn = document.querySelector(
      '[data-test="find-breaks-close"], [data-test="find-breaks-confirm"]',
    ) as HTMLElement;
    expect(dialogBtn).toBeTruthy();
    const inDialog = ctrlZ(dialogBtn);
    expect(inDialog.defaultPrevented).toBe(false);
    expect(session.outline.value).toHaveLength(3);
    expect(document.querySelector('[data-test="find-breaks-dialog"]')).toBeTruthy();

    const page = w.get('.manuscript-editor .page .ProseMirror').element;
    const held = ctrlZ(page, true);
    expect(held.defaultPrevented).toBe(false);
    expect(session.outline.value).toHaveLength(3);

    const once = ctrlZ(page);
    expect(once.defaultPrevented).toBe(true);
    await settle();
    expect(session.outline.value).toHaveLength(1);
    const again = ctrlZ(page);
    expect(again.defaultPrevented).toBe(false);
    await settle();
    expect(session.outline.value).toHaveLength(1);
    noteMount.unmount();
    w.unmount();
  });

  it('scrolls an off-screen paragraph into the open band beside the preview card', async () => {
    const { w } = await withBook(TWO_BREAKS);
    await openFindBreaks(w);
    const root = w.get('[data-test="continuous-manuscript"]').element as HTMLElement;
    const dialog = document.querySelector('[data-test="find-breaks-dialog"]') as HTMLElement;
    let scrollTop = 0;
    Object.defineProperty(root, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    Object.defineProperty(root, 'scrollHeight', { configurable: true, value: 2400 });
    Object.defineProperty(root, 'clientHeight', { configurable: true, value: 800 });
    const rect = (top: number, right: number, bottom: number, left: number) =>
      ({
        top,
        right,
        bottom,
        left,
        width: right - left,
        height: bottom - top,
        x: left,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    const rootRect = rect(40, 900, 840, 0);
    const card = rect(220, 760, 620, 200);
    const orig = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this === root) return rootRect;
      if (this === dialog) return card;
      if (root.contains(this) && this.closest('.ProseMirror')) {
        const top = 900 - scrollTop;
        return rect(top, 700, top + 20, 220);
      }
      return orig.call(this);
    };
    const lineAt = () => {
      const top = 900 - scrollTop;
      return rect(top, 700, top + 20, 220);
    };
    const before = lineAt();
    expect(before.top).toBeGreaterThanOrEqual(rootRect.bottom);
    (document.querySelector('[data-test="find-breaks-show"]') as HTMLElement).click();
    await settle();
    const line = lineAt();
    expect(line.top).toBeGreaterThanOrEqual(rootRect.top - 1);
    expect(line.bottom).toBeLessThanOrEqual(rootRect.bottom + 1);
    const clear =
      line.bottom <= card.top + 1 ||
      line.top >= card.bottom - 1 ||
      line.right <= card.left + 1 ||
      line.left >= card.right - 1;
    expect(clear).toBe(true);
    expect(scrollTop).not.toBe(0);
    expect(document.querySelector('[data-test="find-breaks-dialog"]')).toBeTruthy();
    HTMLElement.prototype.getBoundingClientRect = orig;
    w.unmount();
  });
});
