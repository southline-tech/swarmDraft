import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import * as Y from 'yjs';
import { docToYDoc, importDocx, readStructure, writeStructure, yDocToDoc } from '@coauthor/docx';
import App from './App.vue';
import { PRODUCT_NAME } from './lib/brand';
import { storedFixture } from './stored-fixture.test-helper';
import { openSession, sessionFromDocx } from './manuscript-session';
import { docWordCount } from './status/wordcount';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

enableAutoUnmount(afterEach);

const fixture = resolve(
  __dirname,
  '../../../fixtures/manuscripts/docx-import/mock-manuscript.docx',
);
const bytes = () => new Uint8Array(readFileSync(fixture));
const settle = async () => {
  await flushPromises();
  await flushPromises();
};

function outlineCtx(testId: string) {
  const el = document.body.querySelector(`[data-test="${testId}"]`);
  if (!el) throw new Error(`Missing outline menu control: ${testId}`);
  return el as HTMLElement;
}
async function clickOutlineCtx(testId: string) {
  outlineCtx(testId).click();
  await settle();
}
async function openOutlineCtx(w: ReturnType<typeof mount>, sectionId: string) {
  await w
    .find(`[data-test="section-${sectionId}"]`)
    .trigger('contextmenu', { clientX: 40, clientY: 40 });
  await settle();
}

function leadEditor(w: ReturnType<typeof mount>) {
  return w.find('[data-test="lead-editor"]').findComponent({ name: 'ManuscriptEditor' });
}

function hasContinuousManuscript(w: ReturnType<typeof mount>) {
  return w.find('[data-test="continuous-manuscript"]').exists();
}

function editorSurface(w: ReturnType<typeof mount>) {
  return hasContinuousManuscript(w)
    ? w.find('[data-test="lead-editor"] .tiptap')
    : w.find('.tiptap');
}

function proseFind(w: ReturnType<typeof mount>) {
  return hasContinuousManuscript(w)
    ? w.find('[data-test="lead-editor"] .ProseMirror')
    : w.find('.ProseMirror');
}

function proseDom(w: ReturnType<typeof mount>): HTMLElement {
  return (
    hasContinuousManuscript(w)
      ? w.get('[data-test="lead-editor"] .ProseMirror').element
      : w.get('.ProseMirror').element
  ) as HTMLElement;
}

function leadFocusModeOn(w: ReturnType<typeof mount>) {
  return w.find('[data-test="lead-editor"] [data-focus-mode]').exists();
}

function leadFocusModeOff(w: ReturnType<typeof mount>) {
  return !leadFocusModeOn(w);
}

function leadTiptapEditor(w: ReturnType<typeof mount>) {
  return (
    editorSurface(w).element as unknown as {
      editor: import('@tiptap/core').Editor;
    }
  ).editor;
}

async function withManuscript() {
  const w = mount(App, { attachTo: document.body });
  await flushPromises();
  const session = sessionFromDocx(bytes(), 'm1');
  (w.vm as unknown as { open: (s: typeof session) => void }).open(session);
  await settle();
  const titles = () => w.findAll('.row .title').map((r) => r.text());
  return { w, session, titles };
}

async function chooseFile(w: ReturnType<typeof mount>) {
  const input = w.find('[data-test="open-docx"]');
  const file = new File([bytes()], 'synthetic.docx');
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes().buffer });
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
  await input.trigger('change');
  await settle();
}

async function openSettings(w: ReturnType<typeof mount>) {
  if (!w.find('[data-test="settings"]').exists()) {
    await w.find('[data-test="settings-open"]').trigger('click');
  }
}

/** DOM typing path; honours read-only (see ManuscriptEditor.test.ts). */
async function typeThroughDom(editor: import('@tiptap/core').Editor, text: string) {
  let node: Node | null = editor.view.dom;
  while (node && node.nodeType !== Node.TEXT_NODE) node = node.firstChild;
  if (!node) throw new Error('no text node to type into');
  (node as Text).data += text;
  (editor.view as unknown as { domObserver: { flush(): void } }).domObserver.flush();
  await flushPromises();
}

describe('App', () => {
  it('saves an imported .docx to the backend before opening it', async () => {
    const backend = await import('./backend');
    const persist = vi.mocked(backend.persistImport);
    persist.mockClear();
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await chooseFile(w);
    expect(persist).toHaveBeenCalledTimes(1);
    const payload = persist.mock.calls[0]![0];
    const expected = importDocx(bytes(), { manuscriptId: 'x' });
    expect(payload.title).toBe(expected.title);
    expect(payload.sections.map((s) => [s.kind, s.title])).toEqual(
      expected.sections.map((s) => [s.kind, s.title]),
    );
    expect(payload.sections.every((s) => (s.doc as { type: string }).type === 'doc')).toBe(true);
    expect(w.findAll('.row').length).toBe(expected.sections.length);
    w.unmount();
  });

  it('opens the import from the stored rows (ids, parents, doc ids), editable', async () => {
    const stored = storedFixture();
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await chooseFile(w);
    expect(w.findAll('.row .title').map((r) => r.text())).toEqual(
      stored.sections.map((s) => s.title),
    );
    for (const s of stored.sections) {
      expect(w.find(`[data-test="section-${s.id}"]`).exists()).toBe(true);
    }
    expect(proseFind(w).attributes('contenteditable')).toBe('true');
    w.unmount();
  });

  it('disables the file input while an import is running', async () => {
    const backend = await import('./backend');
    let release!: (v: ReturnType<typeof storedFixture>) => void;
    vi.mocked(backend.persistImport).mockImplementationOnce(
      () => new Promise((r) => (release = r)),
    );
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const input = w.find('[data-test="open-docx"]');
    const file = new File([bytes()], 'synthetic.docx');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes().buffer });
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
    await input.trigger('change');
    await flushPromises();
    expect((input.element as HTMLInputElement).disabled).toBe(true);
    release(storedFixture());
    await settle();
    expect((input.element as HTMLInputElement).disabled).toBe(false);
    w.unmount();
  });

  it('type, restart, and the typed text is still there (saved through the backend)', async () => {
    const backend = await import('./backend');
    // A fake backend: the stored state plus every saved update, per section.
    const stored = storedFixture();
    const saved = new Map<string, Uint8Array[]>();
    vi.mocked(backend.persistImport).mockResolvedValueOnce(stored);
    vi.mocked(backend.saveSectionUpdate).mockImplementation(async (m, sec, u) => {
      expect(m).toBe(stored.manuscript.id);
      saved.set(sec, [...(saved.get(sec) ?? []), u]);
    });
    const first = mount(App, { attachTo: document.body });
    await flushPromises();
    await chooseFile(first);
    const chapter = first.findAll('.row').length;
    expect(chapter).toBeGreaterThan(0);
    const editor = leadTiptapEditor(first);
    editor.commands.insertContentAt(1, 'TYPED ');
    await settle();
    first.unmount(); // closing flushes pending edits
    await settle();
    expect([...saved.keys()].length).toBe(1);

    // Restart: the backend returns the stored state with the saved updates applied.
    const reopened = {
      ...stored,
      sections: stored.sections.map((s) => {
        const d = new Y.Doc();
        Y.applyUpdate(d, Uint8Array.from(s.state));
        for (const u of saved.get(s.id) ?? []) Y.applyUpdate(d, u);
        return { ...s, state: Array.from(Y.encodeStateAsUpdate(d)) };
      }),
    };
    vi.mocked(backend.openLatestManuscript).mockResolvedValueOnce(reopened);
    const w = mount(App, { attachTo: document.body });
    await settle();
    expect(w.findAll('.row').length).toBe(chapter);
    expect(proseFind(w).text()).toContain('TYPED ');
    w.unmount();
    vi.mocked(backend.saveSectionUpdate).mockReset();
  });

  it("makes a closed session's editor read-only", async () => {
    const { w, session } = await withManuscript();
    expect(editorSurface(w).attributes('contenteditable')).toBe('true');
    await session.close();
    await settle();
    expect(editorSurface(w).attributes('contenteditable')).toBe('false');
    w.unmount();
  });

  it('shows an error and does not open the import when saving fails', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.persistImport).mockRejectedValueOnce('database is locked');
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await chooseFile(w);
    expect(w.find('[data-test="opening-error"]').text()).toContain(
      'This book is open in another program',
    );
    expect(w.text()).not.toContain('database is locked');
    expect(w.findAll('.row')).toHaveLength(0);
    expect(w.find('[data-test="opening-error"]').exists()).toBe(true);
    w.unmount();
  });

  it('shows ob6 after the reveal delay while import is still running (#80)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const backend = await import('./backend');
    let done!: (v: ReturnType<typeof storedFixture>) => void;
    vi.mocked(backend.persistImport).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          done = resolve;
        }),
    );
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const picked = chooseFile(w);
    await flushPromises();
    expect(w.find('[data-test="opening-progress"]').exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(150);
    expect(w.find('[data-test="opening-progress"]').exists()).toBe(true);
    done(storedFixture());
    await picked;
    await flushPromises();
    expect(w.find('[data-test="opening-progress"]').exists()).toBe(false);
    w.unmount();
    vi.useRealTimers();
  });

  it('does not flash ob6 when import finishes before the reveal delay (#80)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await chooseFile(w);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(50);
    expect(w.find('[data-test="opening-progress"]').exists()).toBe(false);
    w.unmount();
    vi.useRealTimers();
  });

  it('maps import failures through mapError on the opening error card (#80)', async () => {
    const backend = await import('./backend');
    let onProgress: ((e: import('./backend').OpeningProgressEvent) => void) | undefined;
    vi.mocked(backend.listenOpeningProgress).mockImplementationOnce(async (cb) => {
      onProgress = cb;
      return () => {};
    });
    vi.mocked(backend.persistImport).mockImplementationOnce(async (payload) => {
      onProgress?.({
        stage: 'saving',
        percent: 40,
        title: payload.title,
        chaptersFound: payload.sections.filter((s) => s.kind === 'chapter').length,
      });
      throw new Error('truncated zip');
    });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await chooseFile(w);
    expect(w.find('[data-test="opening-error"]').text()).toContain("We couldn't read this file");
    expect(w.text()).not.toContain('truncated');
    w.unmount();
  });

  it('announce opening errors in an assertive live region (#80)', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.persistImport).mockRejectedValueOnce('database is locked');
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await chooseFile(w);
    const region = w.get('[data-test="opening-error"]');
    expect(region.attributes('role')).toBe('alert');
    expect(region.attributes('aria-live')).toBe('assertive');
    expect(region.find('[data-test="error-card"]').exists()).toBe(true);
    w.unmount();
  });

  it('Try again on opening error retries the import (#80)', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.persistImport)
      .mockRejectedValueOnce('database is locked')
      .mockResolvedValueOnce(storedFixture());
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    vi.mocked(backend.persistImport).mockClear();
    await chooseFile(w);
    expect(vi.mocked(backend.persistImport)).toHaveBeenCalledTimes(1);
    await w.get('[data-test="error-card"] .sh-btn--primary').trigger('click');
    await settle();
    expect(w.findAll('.row').length).toBeGreaterThan(0);
    expect(vi.mocked(backend.persistImport)).toHaveBeenCalledTimes(2);
    w.unmount();
  });

  it('cold reopen ob6 title uses the stored book name, not the product name (#80)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const backend = await import('./backend');
    vi.mocked(backend.listManuscripts).mockResolvedValueOnce([
      { id: 'm1', title: 'Harbor Light', createdAt: '2026-01-01', numberingStyle: 'arabic' },
    ]);
    let finish!: (v: ReturnType<typeof storedFixture>) => void;
    const pending = new Promise<ReturnType<typeof storedFixture>>((resolve) => {
      finish = resolve;
    });
    vi.mocked(backend.openLatestManuscript).mockImplementationOnce(() => pending);
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(150);
    expect(w.text()).toContain('Harbor Light');
    expect(w.text()).not.toContain(`Opening “${PRODUCT_NAME}”`);
    finish(storedFixture());
    await flushPromises();
    w.unmount();
    vi.useRealTimers();
  });

  it('renders in browser mode without the desktop backend, with no sample outline', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.getAppInfo).mockResolvedValueOnce(null);
    const w = mount(App);
    await flushPromises();
    expect(w.text()).toContain(PRODUCT_NAME);
    await openSettings(w);
    expect(w.find('[data-test="browser-mode"]').exists()).toBe(true);
    expect(w.find('[data-test="no-manuscript"]').exists()).toBe(true);
    expect(w.findAll('.row')).toHaveLength(0);
  });

  it('shows the imported parts and chapters in the sidebar', async () => {
    const { w, titles } = await withManuscript();
    const expected = importDocx(bytes(), { manuscriptId: 'm1' }).sections.map((s) => s.title);
    expect(titles()).toEqual(expected);
    expect(titles()).toContain('Part Two: Salt and Lamplight');
    expect(titles()).toContain('Chapter 4: The Ledger');
    expect(proseFind(w).exists()).toBe(true);
    w.unmount();
  });

  it('the toolbar Chapters button toggles the chapter navigator', async () => {
    const { w } = await withManuscript();
    const nav = w.find('[data-test="tb-navigator"]');
    const sidebar = () => w.findComponent({ name: 'SectionNav' });
    expect(nav.attributes('aria-pressed')).toBe('true');
    expect(sidebar().isVisible()).toBe(true);
    await nav.trigger('click');
    expect(nav.attributes('aria-pressed')).toBe('false');
    expect(sidebar().isVisible()).toBe(false);
    // The grid collapses so the editor takes the full width, not the old 18rem column.
    const ws = w.find('[data-test="workspace"]');
    expect(ws.classes()).toContain('grid-cols-1');
    expect(ws.classes()).not.toContain('grid-cols-[18rem_1fr]');
    expect(nav.attributes('aria-controls')).toBe(sidebar().attributes('id'));
    await nav.trigger('click');
    expect(nav.attributes('aria-pressed')).toBe('true');
    expect(sidebar().isVisible()).toBe(true);
    expect(w.find('[data-test="workspace"]').classes()).toContain('grid-cols-[18rem_1fr]');
    w.unmount();
  });

  it.skip.each(['part', 'chapter', 'front_matter', 'back_matter'] as const)(
    'a new %s from the navigator opens editable and takes typing (#42; add UI deferred #108)',
    async (kind) => {
      const { w, session } = await withManuscript();
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const chapter = readStructure(session.manuscript).find((s) => s.kind === 'chapter')!;
      await w.find(`[data-test="section-${chapter.id}"]`).trigger('click');
      await settle();
      const before = new Set(readStructure(session.manuscript).map((s) => s.id));
      await w.find(`[data-test="add-${kind}"]`).trigger('click');
      await settle();
      await w.find('[data-test="rename-input"]').trigger('keydown', { key: 'Enter' });
      await settle();
      const added = readStructure(session.manuscript).find((s) => !before.has(s.id))!;
      expect(added.kind).toBe(kind);
      await new Promise((r) => setTimeout(r, 0));
      expect(w.find('[data-test="load-error"]').exists()).toBe(false);
      const editor = (
        editorSurface(w).element as unknown as { editor: import('@tiptap/core').Editor }
      ).editor;
      expect(editor.isEditable).toBe(true);
      editor.view.dispatch(editor.state.tr.insertText('Synthetic typing'));
      await flushPromises();
      expect(JSON.stringify(yDocToDoc(session.sections.get(added.docId)!))).toContain(
        'Synthetic typing',
      );
      expect(errors.mock.calls.flat().join(' ')).not.toContain('Invalid content');
      errors.mockRestore();
      w.unmount();
    },
  );

  it.skip.each(['part', 'chapter', 'front_matter', 'back_matter'] as const)(
    'text typed in a new %s is saved, survives a restart, and switching away and back (#42; add UI deferred #108)',
    async (kind) => {
      const backend = await import('./backend');
      // A fake backend: the stored state, the last saved outline, and every saved update.
      const stored = storedFixture();
      const saved = new Map<string, Uint8Array[]>();
      let outline: Parameters<typeof backend.saveOutline>[1] | null = null;
      vi.mocked(backend.persistImport).mockResolvedValueOnce(stored);
      vi.mocked(backend.saveSectionUpdate).mockImplementation(async (m, sec, u) => {
        expect(m).toBe(stored.manuscript.id);
        saved.set(sec, [...(saved.get(sec) ?? []), u]);
      });
      vi.mocked(backend.saveOutline).mockImplementation(async (m, next) => {
        expect(m).toBe(stored.manuscript.id);
        outline = next;
      });
      const editorOf = (w: ReturnType<typeof mount>) => leadTiptapEditor(w);
      const first = mount(App, { attachTo: document.body });
      await flushPromises();
      await chooseFile(first);
      const chapter = stored.sections.find((s) => s.kind === 'chapter')!;
      await first.find(`[data-test="section-${chapter.id}"]`).trigger('click');
      await settle();
      const before = new Set(stored.sections.map((s) => s.id));
      await first.find(`[data-test="add-${kind}"]`).trigger('click');
      await settle();
      await first.find('[data-test="rename-input"]').trigger('keydown', { key: 'Enter' });
      await settle();
      await new Promise((r) => setTimeout(r, 0));
      expect(outline).not.toBeNull();
      const added = outline!.find((s) => !before.has(s.id))!;
      expect(added.kind).toBe(kind);
      const text = `Synthetic persisted ${kind} line`;
      editorOf(first).commands.insertContent(text);
      await settle();
      first.unmount(); // closing flushes pending edits
      await settle();
      expect(saved.get(added.id)?.length ?? 0).toBeGreaterThan(0);

      // Restart: the backend returns the saved outline, each section's stored state plus its
      // saved updates (a new section starts from an empty doc).
      const rows = new Map(stored.sections.map((s) => [s.id, s]));
      const reopened = {
        ...stored,
        sections: outline!.map((o, position) => {
          const d = new Y.Doc();
          const row = rows.get(o.id);
          if (row) Y.applyUpdate(d, Uint8Array.from(row.state));
          for (const u of saved.get(o.id) ?? []) Y.applyUpdate(d, u);
          return {
            id: o.id,
            manuscriptId: stored.manuscript.id,
            kind: o.kind,
            parentId: o.parentId ?? null,
            position,
            title: o.title,
            docId: o.docId,
            state: Array.from(Y.encodeStateAsUpdate(d)),
          };
        }),
      };
      vi.mocked(backend.openLatestManuscript).mockResolvedValueOnce(reopened);
      const w = mount(App, { attachTo: document.body });
      await settle();
      await w.find(`[data-test="section-${added.id}"]`).trigger('click');
      await settle();
      await new Promise((r) => setTimeout(r, 0));
      expect(w.find('[data-test="load-error"]').exists()).toBe(false);
      expect(editorSurface(w).text()).toContain(text);
      // Switch to another section and back.
      await w.find(`[data-test="section-${chapter.id}"]`).trigger('click');
      await settle();
      expect(editorSurface(w).text()).not.toContain(text);
      await w.find(`[data-test="section-${added.id}"]`).trigger('click');
      await settle();
      await new Promise((r) => setTimeout(r, 0));
      expect(editorSurface(w).text()).toContain(text);
      expect(editorOf(w).isEditable).toBe(true);
      w.unmount();
      vi.mocked(backend.saveSectionUpdate).mockReset().mockResolvedValue(undefined);
      vi.mocked(backend.saveOutline).mockReset().mockResolvedValue(undefined);
    },
  );

  it('clicking an outline row focuses the editor in the body, not the heading (#36)', async () => {
    const { w, session } = await withManuscript();
    const editorOf = () => leadTiptapEditor(w);
    const chapters = readStructure(session.manuscript).filter((s) => s.kind === 'chapter');
    const warn = vi.spyOn(console, 'warn');
    const stateBefore = new Map(
      chapters.map((c) => [c.id, Y.encodeStateVector(session.sections.get(c.docId)!)]),
    );
    for (const ch of chapters.slice(0, 2)) {
      const row = w.find(`[data-test="section-${ch.id}"]`);
      (row.element as HTMLElement).focus();
      await row.trigger('click');
      await settle();
      await new Promise((r) => setTimeout(r, 0));
      const editor = editorOf();
      expect(editor.isFocused).toBe(true);
      // Focus really left the outline row for the editor.
      expect(editor.view.dom.contains(document.activeElement)).toBe(true);
      expect(row.element.contains(document.activeElement)).toBe(false);
      const { $from } = editor.state.selection;
      const doc = session.sections.get(ch.docId)!;
      const hasBody = JSON.stringify(yDocToDoc(doc)).includes('"style":"body"');
      if (hasBody) {
        expect($from.parent.attrs.style).not.toBe('heading');
        expect($from.parentOffset).toBe(0);
      } else {
        // Heading-only chapter: cursor at the end of the heading, nothing added.
        expect($from.parentOffset).toBe($from.parent.content.size);
      }
      // Navigating changes neither the stored doc nor the undo history.
      expect(Y.encodeStateVector(doc)).toEqual(stateBefore.get(ch.id));
      const undoPlugin = editor.state.plugins.find((p) =>
        (p as unknown as { key: string }).key.startsWith('y-undo'),
      );
      const undo = undoPlugin?.getState(editor.state) as
        { undoManager: { undoStack: unknown[] } } | undefined;
      expect(undo).toBeDefined();
      expect(undo?.undoManager.undoStack.length ?? 0).toBe(0);
    }
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    w.unmount();
  });

  it('clicking any outline row logs no console warning (#36)', async () => {
    const { w, session } = await withManuscript();
    const warn = vi.spyOn(console, 'warn');
    const rows = readStructure(session.manuscript);
    expect(
      rows.some((r) => {
        const doc = yDocToDoc(session.sections.get(r.docId)!);
        return doc.content?.some((b) => b.type === 'scene_break');
      }),
    ).toBe(true);
    for (const r of rows) {
      await w.find(`[data-test="section-${r.id}"]`).trigger('click');
      await settle();
      await new Promise((res) => setTimeout(res, 0));
    }
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    w.unmount();
  });

  it('keeps typed text and the same editor across a navigator close/open', async () => {
    const { w } = await withManuscript();
    const editorUid = leadEditor(w).vm.$.uid;
    const pm = proseFind(w).element;
    const editorOf = () => leadTiptapEditor(w);
    const editor = editorOf();
    editor.commands.insertContentAt(1, 'NAVKEEP ');
    await flushPromises();
    const nav = w.find('[data-test="tb-navigator"]');
    await nav.trigger('click');
    await nav.trigger('click');
    await flushPromises();
    expect(proseFind(w).text()).toContain('NAVKEEP ');
    expect(leadEditor(w).vm.$.uid).toBe(editorUid);
    expect(proseFind(w).element).toBe(pm);
    expect(editorOf()).toBe(editor);
    w.unmount();
  });

  it('persists rename and reorder to the Yjs structure', async () => {
    const { w, session, titles } = await withManuscript();
    const first = readStructure(session.manuscript).find((s) => s.kind === 'chapter')!;
    await w.find(`[data-test="section-${first.id}"]`).trigger('click');
    await openOutlineCtx(w, first.id);
    await clickOutlineCtx('outline-ctx-rename');
    const input = w.find('[data-test="rename-input"]');
    await input.setValue('Low Tide, Revised');
    await input.trigger('keydown', { key: 'Enter' });
    await settle();
    expect(readStructure(session.manuscript).find((s) => s.id === first.id)?.title).toBe(
      'Low Tide, Revised',
    );

    const chapters = () =>
      readStructure(session.manuscript).filter(
        (s) => s.kind === 'chapter' && s.parentId === first.parentId,
      );
    const second = chapters()[1]!;
    await w.find(`[data-test="section-${second.id}"]`).trigger('click');
    await openOutlineCtx(w, second.id);
    await clickOutlineCtx('outline-ctx-move-up');
    await settle();
    expect(
      chapters()
        .slice(0, 2)
        .map((s) => s.id),
    ).toEqual([second.id, first.id]);

    // A reopened copy (persisted update) sees the same outline the sidebar shows.
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(session.manuscript));
    expect(readStructure(copy).map((s) => s.title)).toEqual(titles());
    w.unmount();
  });

  it('deleting the open section opens the fallback section, never the deleted doc', async () => {
    const { w, session } = await withManuscript();
    const chapters = readStructure(session.manuscript).filter((s) => s.kind === 'chapter');
    const second = chapters[1]!;
    await w.find(`[data-test="section-${second.id}"]`).trigger('click');
    await settle();
    await openOutlineCtx(w, second.id);
    await clickOutlineCtx('outline-ctx-delete');
    await w.find('[data-test="confirm-delete-all"]').trigger('click');
    await settle();
    expect(readStructure(session.manuscript).some((s) => s.id === second.id)).toBe(false);
    expect(session.sections.has(second.docId)).toBe(false);
    const nav = w.findComponent({ name: 'SectionNav' });
    const selected = nav.props('selectedId') as string;
    expect(selected).not.toBe(second.id);
    expect(readStructure(session.manuscript).some((s) => s.id === selected)).toBe(true);
    // The editor shows the fallback section's own doc.
    const fallback = readStructure(session.manuscript).find((s) => s.id === selected)!;
    expect(leadEditor(w).props('doc')).toStrictEqual(session.sections.get(fallback.docId));
    w.unmount();
  });

  it('undo delete restores typed section text in the same session (#108)', async () => {
    const { w, session } = await withManuscript();
    const chapter = readStructure(session.manuscript).find((s) => s.kind === 'chapter')!;
    await w.find(`[data-test="section-${chapter.id}"]`).trigger('click');
    await settle();
    leadTiptapEditor(w).commands.insertContent('UNDO-KEEP ');
    await settle();
    await openOutlineCtx(w, chapter.id);
    await clickOutlineCtx('outline-ctx-delete');
    await w.find('[data-test="confirm-delete-all"]').trigger('click');
    await settle();
    await w.find('[data-test="outline-undo-delete-btn"]').trigger('click');
    await settle();
    await w.find(`[data-test="section-${chapter.id}"]`).trigger('click');
    await settle();
    expect(editorSurface(w).text()).toContain('UNDO-KEEP');
    w.unmount();
  });

  it('reflects structure changes made by another writer', async () => {
    const { w, session, titles } = await withManuscript();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(session.manuscript));
    const next = readStructure(peer).map((s, i) =>
      i === 0 ? { ...s, title: 'Renamed by agent' } : s,
    );
    writeStructure(peer, next);
    Y.applyUpdate(session.manuscript, Y.encodeStateAsUpdate(peer));
    await settle();
    expect(titles()[0]).toBe('Renamed by agent');
    w.unmount();
  });
});

describe('App keyboard and placement on an imported manuscript', () => {
  it('groups front matter under one collapsible row and shows a display-only chapter label', async () => {
    const { w, session } = await withManuscript();
    const before = JSON.stringify(readStructure(session.manuscript));
    const group = w.find('[data-test="front-matter-group"]');
    expect(group.exists()).toBe(true);
    expect(group.attributes('aria-expanded')).toBe('false');
    await group.trigger('click');
    await settle();
    expect(w.find('[data-test="front-matter-group"]').attributes('aria-expanded')).toBe('true');
    const label = w.find('[data-test="chapter-label"]');
    if (label.exists()) expect(label.attributes('aria-hidden')).toBe('true');
    expect(JSON.stringify(readStructure(session.manuscript))).toBe(before);
    w.unmount();
  });

  it('selects rows with arrow keys and renames with Enter', async () => {
    const { w, session } = await withManuscript();
    const outline = readStructure(session.manuscript);
    const firstRow = w.find(`[data-test="section-${outline[0]!.id}"]`);
    (firstRow.element as HTMLElement).focus();
    await firstRow.trigger('keydown', { key: 'Home' });
    await w
      .find(`[data-test="section-${outline[0]!.id}"]`)
      .trigger('keydown', { key: 'ArrowDown' });
    await settle();
    const row = w.find(`[data-test="section-${outline[1]!.id}"]`);
    expect(row.attributes('tabindex')).toBe('0');
    await row.trigger('keydown', { key: 'Enter' });
    await settle();
    const input = w.find('[data-test="rename-input"]');
    await input.setValue('Keyboard title');
    await input.trigger('keydown', { key: 'Enter' });
    await settle();
    expect(readStructure(session.manuscript)[1]!.title).toBe('Keyboard title');
    w.unmount();
  });

  it.skip('adds a part before the back matter of the imported book (#108 add UI deferred)', async () => {
    const { w, session } = await withManuscript();
    await w.find('[data-test="add-part"]').trigger('click');
    await settle();
    const kinds = readStructure(session.manuscript).map((s) => s.kind);
    const newPart = kinds.lastIndexOf('part');
    expect(kinds.indexOf('back_matter')).toBeGreaterThan(newPart);
    w.unmount();
  });

  it.skip('places + Part before the back matter and + Front matter after the front matter (#108 add UI deferred)', async () => {
    const { w, session } = await withManuscript();
    const top = () => readStructure(session.manuscript).filter((s) => !s.parentId);
    await w.find('[data-test="add-part"]').trigger('click');
    await settle();
    await w.find('[data-test="rename-input"]').trigger('keydown', { key: 'Escape' });
    let kinds = top().map((s) => s.kind);
    const part = top().findIndex((s) => s.title === 'New part');
    expect(part).toBeGreaterThan(-1);
    expect(kinds.slice(part + 1).every((k) => k === 'back_matter')).toBe(true);
    expect(kinds.slice(0, part)).not.toContain('back_matter');

    await w.find('[data-test="add-front_matter"]').trigger('click');
    await settle();
    kinds = top().map((s) => s.kind);
    const front = top().findIndex((s) => s.title === 'New front matter');
    expect(kinds.slice(0, front).every((k) => k === 'front_matter')).toBe(true);
    expect(kinds[front + 1]).not.toBe('front_matter');
    w.unmount();
  });

  it('saves the repaired outline on open, so a renamed duplicate opens its own doc', async () => {
    const base = sessionFromDocx(bytes(), 'm1');
    const outline = readStructure(base.manuscript);
    const chapter = outline.find((s) => s.kind === 'chapter')!;
    const docId = `${chapter.docId}-copy`;
    base.sections.set(
      docId,
      docToYDoc({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second copy text' }] }],
      } as never),
    );
    writeStructure(base.manuscript, [...outline, { ...chapter, docId, parentId: undefined }]);
    base.close();
    const session = openSession('m1', base.title, base.manuscript, base.sections, base.report);
    const fresh = `${chapter.id}~2`;
    expect(session.repairs.map((r) => r.problem)).toContain('duplicate-id');
    expect(readStructure(session.manuscript).find((s) => s.id === fresh)?.docId).toBe(docId);

    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    (w.vm as unknown as { open: (s: typeof session) => void }).open(session);
    await settle();
    await w.find(`[data-test="section-${fresh}"]`).trigger('click');
    await settle();
    expect(editorSurface(w).text()).toContain('second copy text');
    w.unmount();
  });
});

describe('App open-file input', () => {
  const pick = async (w: ReturnType<typeof mount>, name: string, data: Uint8Array) => {
    const input = w.find('[data-test="open-docx"]');
    const file = { name, arrayBuffer: async () => data.slice().buffer };
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
    await input.trigger('change');
    await settle();
  };

  it('opens a good .docx and reports a bad one without replacing the open manuscript', async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await pick(w, 'mock.docx', bytes());
    expect(w.findAll('.row').length).toBeGreaterThan(0);
    const rows = w.findAll('.row').length;
    expect(w.text()).not.toContain('Could not import');

    await pick(w, 'broken.docx', new TextEncoder().encode('not a zip'));
    expect(w.text()).toContain("Couldn't open broken.docx. This isn't a Word manuscript.");
    expect(w.text()).not.toContain('zip directory');
    expect(w.findAll('.row')).toHaveLength(rows);
    w.unmount();
  });
});

describe('App status bar on an imported manuscript', () => {
  const editorOf = (w: ReturnType<typeof mount>) => leadTiptapEditor(w);
  const num = (w: ReturnType<typeof mount>, t: string) =>
    Number(w.find(`[data-test="status-${t}"]`).text().replace(/[^\d]/g, ''));
  const words = (session: ReturnType<typeof sessionFromDocx>, ids: string[]) =>
    ids.reduce((n, id) => n + docWordCount(session.sections.get(id)!), 0);

  it('shows a chapter by title and counts words in its doc', async () => {
    const { w, session } = await withManuscript();
    const ch = session.outline.value.find((s) => s.kind === 'chapter')!;
    await w.find(`[data-test="section-${ch.id}"]`).trigger('click');
    await settle();
    expect(w.find('[data-test="status-chapter"]').text()).toBe(ch.title);
    const total = docWordCount(session.sections.get(ch.docId)!);
    expect(num(w, 'chapter-words')).toBe(total);
    w.unmount();
  });

  it('shows a book total equal to the sum of all sections', async () => {
    const { w, session } = await withManuscript();
    const all = session.outline.value.map((s) => s.docId);
    expect(num(w, 'book-words')).toBe(words(session, all));
    w.unmount();
  });

  it('updates the counts after the pause, and the text survives switching sections', async () => {
    const { w, session } = await withManuscript();
    const chapters = session.outline.value.filter((s) => s.kind === 'chapter');
    const [first, second] = chapters;
    await w.find(`[data-test="section-${first!.id}"]`).trigger('click');
    await settle();
    const book = num(w, 'book-words');
    const chapter = num(w, 'chapter-words');
    editorOf(w).commands.insertContentAt(1, 'Countme alsome ');
    await settle();
    await new Promise((r) => setTimeout(r, 400));
    await settle();
    expect(num(w, 'book-words')).toBe(book + 2);
    expect(num(w, 'chapter-words')).toBe(chapter + 2);
    await w.find(`[data-test="section-${second!.id}"]`).trigger('click');
    await settle();
    await w.find(`[data-test="section-${first!.id}"]`).trigger('click');
    await settle();
    expect(editorSurface(w).text()).toContain('Countme alsome');
    expect(num(w, 'book-words')).toBe(book + 2);
    w.unmount();
  });

  it('updates the book total when a section that is not open is deleted, then one is added', async () => {
    const { w, session } = await withManuscript();
    const outline = session.outline.value;
    const open = outline.find((s) => s.kind === 'chapter')!;
    await w.find(`[data-test="section-${open.id}"]`).trigger('click');
    await settle();
    const book = num(w, 'book-words');
    // A leaf section with text that is not the open one.
    const gone = outline.find(
      (s) =>
        s.id !== open.id &&
        !outline.some((c) => c.parentId === s.id) &&
        docWordCount(session.sections.get(s.docId)!) > 0,
    )!;
    const goneWords = docWordCount(session.sections.get(gone.docId)!);
    const goneDoc = session.sections.get(gone.docId)!;
    await session.save(outline.filter((s) => s.id !== gone.id));
    await settle();
    expect(num(w, 'book-words')).toBe(book - goneWords);
    expect(editorSurface(w).exists()).toBe(true);
    // The deleted doc is no longer watched: editing it changes nothing.
    goneDoc.getXmlFragment('prosemirror').insert(0, [new Y.XmlElement('paragraph')]);
    await new Promise((r) => setTimeout(r, 400));
    await settle();
    expect(num(w, 'book-words')).toBe(book - goneWords);
    await session.save([
      ...session.outline.value,
      {
        ...gone,
        id: 'added-1',
        docId: 'added-doc-1',
        title: 'Added',
        parentId: undefined,
        kind: 'chapter',
      },
    ] as never);
    await settle();
    const added = session.sections.get('added-doc-1');
    expect(added).toBeDefined();
    const text = new Y.XmlText();
    const p = new Y.XmlElement('paragraph');
    p.insert(0, [text]);
    added!.getXmlFragment('prosemirror').insert(0, [p]);
    text.insert(0, 'Brand new words');
    await new Promise((r) => setTimeout(r, 400));
    await settle();
    expect(num(w, 'book-words')).toBe(book - goneWords + 3);
    w.unmount();
  });

  it('shows "Not saved, retrying" when a save fails, alongside the existing alert', async () => {
    // Uses the backend-saved import path (chooseFile), whose saves go through saveSectionUpdate.
    const backend = await import('./backend');
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await chooseFile(w);
    vi.mocked(backend.saveSectionUpdate).mockRejectedValue('disk full');
    await vi.waitFor(() => expect(editorSurface(w).exists()).toBe(true));
    editorOf(w).commands.insertContentAt(1, 'Unsaved ');
    await settle();
    await vi.waitFor(() =>
      expect(w.find('[data-test="status-save"]').text()).toBe('Not saved, retrying'),
    );
    expect(w.find('[data-test="save-error"]').text()).toContain(
      "Your latest changes aren't saved yet",
    );
    expect(w.find('[data-test="save-error"]').text()).not.toContain('disk full');
    vi.mocked(backend.saveSectionUpdate).mockReset().mockResolvedValue(undefined);
    editorOf(w).commands.insertContentAt(1, 'Recovered ');
    await settle();
    await vi.waitFor(() => expect(w.find('[data-test="save-error"]').exists()).toBe(false));
    await vi.waitFor(() => expect(w.find('[data-test="status-save"]').text()).toBe('Saved'));
    const next = sessionFromDocx(bytes(), 'm-other');
    (w.vm as unknown as { open: (s: typeof next) => void }).open(next);
    await settle();
    expect(w.find('[data-test="status-save"]').text()).toBe('');
    w.unmount();
  });
});

describe('App saves typing to the section Y.Doc', () => {
  const editorOf = (w: ReturnType<typeof mount>) => leadTiptapEditor(w);
  const chaptersOf = (session: ReturnType<typeof sessionFromDocx>) =>
    session.outline.value.filter((s) => s.kind === 'chapter');
  const openedOf = (w: ReturnType<typeof mount>, session: ReturnType<typeof sessionFromDocx>) => {
    const id = w.findComponent({ name: 'SectionNav' }).props('selectedId') as string;
    return session.outline.value.find((s) => s.id === id)!;
  };

  it('opens on the first chapter', async () => {
    const { w, session } = await withManuscript();
    const opened = openedOf(w, session);
    expect(opened.kind).toBe('chapter');
    expect(opened.id).toBe(chaptersOf(session)[0]!.id);
    w.unmount();
  });

  it('keeps typed text after Reload', async () => {
    const { w, session } = await withManuscript();
    editorOf(w).commands.insertContentAt(1, 'TYPEDONE ');
    await settle();
    const docId = openedOf(w, session).docId;
    expect(JSON.stringify(yDocToDoc(session.sections.get(docId)!))).toContain('TYPEDONE');
    leadEditor(w).vm.$emit('reload');
    await settle();
    expect(editorSurface(w).text()).toContain('TYPEDONE');
    w.unmount();
  });

  it('keeps typed text after switching to another section and back', async () => {
    const { w, session } = await withManuscript();
    const first = openedOf(w, session);
    const second = chaptersOf(session)[1];
    editorOf(w).commands.insertContentAt(1, 'TYPEDTWO ');
    await settle();
    await w.find(`[data-test="section-${second!.id}"]`).trigger('click');
    await settle();
    expect(editorSurface(w).text()).not.toContain('TYPEDTWO');
    await w.find(`[data-test="section-${first!.id}"]`).trigger('click');
    await settle();
    expect(editorSurface(w).text()).toContain('TYPEDTWO');
    w.unmount();
  });
});

vi.mock('./backend', async (orig) => ({
  ...(await orig<typeof import('./backend')>()),
  agentsApi: {
    list: vi.fn(async () => []),
    primaryId: vi.fn(async () => null),
    tokens: vi.fn(async () => []),
  },
  getAppInfo: vi.fn(async () => ({
    version: '0.1.0',
    dataDir: '/tmp/x',
    schemaVersion: 1,
    computerName: 'TestWriter',
  })),
  createBackup: vi.fn(async () => true),
  getRecoveryNotices: vi.fn(async () => []),
  persistImport: vi.fn(async () => storedFixture()),
  openLatestManuscript: vi.fn(async () => null),
  listManuscripts: vi.fn(async () => []),
  loadManuscript: vi.fn(async () => null),
  saveSectionUpdate: vi.fn(async () => {}),
  saveOutline: vi.fn(async () => {}),
  dismissRecoveryNotices: vi.fn(async () => {}),
  getMigrationNotices: vi.fn(async () => []),
  dismissMigrationNotices: vi.fn(async () => {}),
  saveManuscriptCopy: vi.fn(async () => 'D:\\Copies\\book.docx'),
  restoreBackup: vi.fn(async () => ({ tokensRevoked: 2 })),
  listenOpeningProgress: vi.fn(async () => () => {}),
}));

describe('save-failure banner', () => {
  it('Save a copy writes a .docx with the unsaved edits while saves keep failing', async () => {
    const backend = await import('./backend');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await chooseFile(w);
    vi.mocked(backend.saveSectionUpdate).mockRejectedValue('io: database is locked');
    await vi.waitFor(() => expect(editorSurface(w).exists()).toBe(true));
    const editor = (
      editorSurface(w).element as unknown as { editor: import('@tiptap/core').Editor }
    ).editor;
    editor.commands.insertContentAt(1, 'ONLYINMEMORY ');
    await vi.waitFor(() => expect(w.find('[data-test="save-copy"]').exists()).toBe(true));
    expect(w.find('[data-test="save-error"]').text()).not.toContain('database is locked');
    const write = vi.mocked(backend.saveManuscriptCopy);
    write.mockClear();
    await w.find('[data-test="save-copy"]').trigger('click');
    await settle();
    expect(write).toHaveBeenCalledTimes(1);
    const [, bytes] = write.mock.calls[0]!;
    expect(JSON.stringify(importDocx(bytes).sections)).toContain('ONLYINMEMORY');
    expect(w.find('[data-test="save-copy-result"]').text()).toContain('Copy saved to');
    vi.mocked(backend.saveSectionUpdate).mockReset().mockResolvedValue(undefined);
    w.unmount();
    log.mockRestore();
  });
});

describe('restore confirmation', () => {
  it('keeps the editor read-only while restore_backup runs (RAD-237)', async () => {
    const backend = await import('./backend');
    let release!: () => void;
    const gate = new Promise<{ tokensRevoked: number } | null>((resolve) => {
      release = () => resolve({ tokensRevoked: 0 });
    });
    vi.mocked(backend.restoreBackup).mockImplementationOnce(() => gate);
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await chooseFile(w);
    await vi.waitFor(() => expect(editorSurface(w).exists()).toBe(true));
    const editor = (
      editorSurface(w).element as unknown as { editor: import('@tiptap/core').Editor }
    ).editor;
    expect(editor.isEditable).toBe(true);
    await openSettings(w);
    await w.find('[data-test="restore-pick"]').trigger('click');
    await w.find('[data-test="restore-confirm-yes"]').trigger('click');
    await vi.waitFor(() => expect(editor.isEditable).toBe(false));
    const before = editor.state.doc;
    expect(editor.view.dom.getAttribute('contenteditable')).toBe('false');
    expect(w.find('[data-test="tb-bold"]').attributes('title')).toBe(
      'Read-only: restore in progress',
    );
    await typeThroughDom(editor, 'Blocked during restore');
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(editor.getText()).not.toContain('Blocked during restore');
    release();
    await flushPromises();
    await vi.waitFor(() =>
      expect(w.find('[data-test="backup-status"]').text()).toContain('Restored'),
    );
    w.unmount();
  });

  it('returns the editor to editable when restore is cancelled with a book open (RAD-237)', async () => {
    const backend = await import('./backend');
    let release!: () => void;
    const gate = new Promise<null>((resolve) => {
      release = () => resolve(null);
    });
    vi.mocked(backend.restoreBackup).mockImplementationOnce(() => gate);
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await chooseFile(w);
    await vi.waitFor(() => expect(editorSurface(w).exists()).toBe(true));
    const editor = (
      editorSurface(w).element as unknown as { editor: import('@tiptap/core').Editor }
    ).editor;
    await openSettings(w);
    await w.find('[data-test="restore-pick"]').trigger('click');
    await w.find('[data-test="restore-confirm-yes"]').trigger('click');
    await vi.waitFor(() => expect(editor.isEditable).toBe(false));
    release();
    await flushPromises();
    await vi.waitFor(() => expect(editor.isEditable).toBe(true));
    expect(editor.view.dom.getAttribute('contenteditable')).not.toBe('false');
    expect(editorSurface(w).exists()).toBe(true);
    w.unmount();
  });

  it('saves pending edits before the restore snapshot, then drops the stale session', async () => {
    const backend = await import('./backend');
    const order: string[] = [];
    vi.mocked(backend.saveSectionUpdate).mockImplementation(async () => void order.push('save'));
    vi.mocked(backend.restoreBackup).mockImplementationOnce(async () => {
      order.push('restore');
      return { tokensRevoked: 0 };
    });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await chooseFile(w);
    const editor = await vi.waitFor(() => {
      const e = (
        editorSurface(w).element as unknown as { editor?: import('@tiptap/core').Editor } | null
      )?.editor;
      if (!e) throw new Error('editor not mounted yet');
      return e;
    });
    editor.commands.insertContentAt(1, 'PENDING ');
    await openSettings(w);
    await w.find('[data-test="restore-pick"]').trigger('click');
    await w.find('[data-test="restore-confirm-yes"]').trigger('click');
    await flushPromises();
    expect(order).toEqual(['save', 'restore']);
    expect(editorSurface(w).exists()).toBe(false);
    await new Promise((r) => setTimeout(r, 700));
    expect(order).toEqual(['save', 'restore']);
    w.unmount();
    vi.mocked(backend.saveSectionUpdate).mockReset();
    vi.mocked(backend.restoreBackup).mockClear();
  });

  it('writes the import only after the current manuscript is closed (edits saved first)', async () => {
    const backend = await import('./backend');
    const order: string[] = [];
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await chooseFile(w);
    vi.mocked(backend.saveSectionUpdate).mockImplementation(async () => void order.push('save'));
    vi.mocked(backend.persistImport).mockImplementationOnce(async () => {
      order.push('write');
      return storedFixture();
    });
    const editor = await vi.waitFor(() => {
      const e = (
        editorSurface(w).element as unknown as { editor?: import('@tiptap/core').Editor } | null
      )?.editor;
      if (!e) throw new Error('editor not mounted yet');
      return e;
    });
    editor.commands.insertContentAt(1, 'BEFORE ');
    await chooseFile(w);
    await flushPromises();
    expect(order).toEqual(['save', 'write']);
    w.unmount();
    vi.mocked(backend.saveSectionUpdate).mockReset();
  });

  it('a failed close writes no import, so relaunch reopens the original manuscript', async () => {
    const backend = await import('./backend');
    // A fake database: rows in creation order; open_latest returns the newest.
    const original = storedFixture();
    const rows = [original];
    vi.mocked(backend.openLatestManuscript).mockImplementation(async () => rows.at(-1) ?? null);
    vi.mocked(backend.persistImport).mockClear();
    vi.mocked(backend.persistImport).mockImplementation(async () => {
      const m = storedFixture();
      m.manuscript.id = 'db-new';
      rows.push(m);
      return m;
    });
    const w = mount(App, { attachTo: document.body });
    await settle();
    vi.mocked(backend.saveSectionUpdate).mockRejectedValue(new Error('database is locked'));
    const editor = await vi.waitFor(() => {
      const e = (
        editorSurface(w).element as unknown as { editor?: import('@tiptap/core').Editor } | null
      )?.editor;
      if (!e) throw new Error('editor not mounted yet');
      return e;
    });
    editor.commands.insertContentAt(1, 'UNSAVED ');
    await chooseFile(w);
    expect(backend.persistImport).not.toHaveBeenCalled();
    expect(rows).toEqual([original]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    w.unmount();
    // Relaunch: the newest row is still the original manuscript.
    expect((await backend.openLatestManuscript())?.manuscript.id).toBe(original.manuscript.id);
    vi.mocked(backend.saveSectionUpdate).mockReset();
    vi.mocked(backend.openLatestManuscript).mockReset().mockResolvedValue(null);
    vi.mocked(backend.persistImport)
      .mockReset()
      .mockImplementation(async () => storedFixture());
    vi.restoreAllMocks();
  });

  it('import and reopen both fail after the close: editor cleared, restart banner, no typing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const backend = await import('./backend');
    vi.mocked(backend.openLatestManuscript).mockResolvedValueOnce(storedFixture());
    const w = mount(App, { attachTo: document.body });
    await settle();
    expect(editorSurface(w).exists()).toBe(true);
    vi.mocked(backend.persistImport).mockRejectedValueOnce('database is locked');
    vi.mocked(backend.openLatestManuscript).mockReset().mockRejectedValue('database is locked');
    const picked = chooseFile(w);
    await vi.advanceTimersByTimeAsync(5000);
    await picked;
    await settle();
    expect(backend.openLatestManuscript).toHaveBeenCalledTimes(4); // first try + 3 backoff retries
    expect(w.find('[data-test="fatal-error"]').text()).toBe(
      `Couldn't reopen the manuscript. Please restart ${PRODUCT_NAME}.`,
    );
    expect(editorSurface(w).exists()).toBe(false);
    expect(w.find('[contenteditable="true"]').exists()).toBe(false);
    w.unmount();
    vi.useRealTimers();
    vi.mocked(backend.openLatestManuscript).mockReset().mockResolvedValue(null);
  });

  it('opens the written import when the switch fails after the write (never deletes it)', async () => {
    const backend = await import('./backend');
    const original = storedFixture();
    const imported = storedFixture();
    imported.manuscript.id = 'db-new';
    vi.mocked(backend.openLatestManuscript).mockResolvedValueOnce(original);
    const w = mount(App, { attachTo: document.body });
    await settle();
    const bad = storedFixture();
    bad.manuscript.id = 'db-new';
    bad.sections[0]!.state = [255, 255, 255];
    vi.mocked(backend.persistImport).mockResolvedValueOnce(bad);
    vi.mocked(backend.openLatestManuscript).mockResolvedValueOnce(imported);
    await chooseFile(w);
    expect(w.find('[contenteditable="true"]').exists()).toBe(true); // the import, reopened
    // The import is open, so no stale "Could not import" error stays on screen (#25 QA).
    expect(w.find('[data-test="open-error"]').exists()).toBe(false);
    expect(w.find('[data-test="opening-error"]').exists()).toBe(false);
    expect(w.find('[data-test="fatal-error"]').exists()).toBe(false);
    w.unmount();
  });

  it('still reports the import when the retry reopens the original manuscript', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.openLatestManuscript).mockResolvedValueOnce(storedFixture());
    const w = mount(App, { attachTo: document.body });
    await settle();
    const bad = storedFixture();
    bad.sections[0]!.state = [255, 255, 255];
    vi.mocked(backend.persistImport).mockResolvedValueOnce(bad);
    vi.mocked(backend.openLatestManuscript).mockResolvedValueOnce(storedFixture()); // same id
    await chooseFile(w);
    expect(w.find('[data-test="open-error"]').text()).toContain("We couldn't read this file");
    w.unmount();
  });

  it('clears the restart banner once a later import opens', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const backend = await import('./backend');
    vi.mocked(backend.openLatestManuscript).mockResolvedValueOnce(storedFixture());
    const w = mount(App, { attachTo: document.body });
    await settle();
    vi.mocked(backend.persistImport).mockRejectedValueOnce('database is locked');
    vi.mocked(backend.openLatestManuscript).mockReset().mockRejectedValue('database is locked');
    const picked = chooseFile(w);
    await vi.advanceTimersByTimeAsync(5000);
    await picked;
    await settle();
    expect(w.find('[data-test="fatal-error"]').exists()).toBe(true);
    vi.useRealTimers();
    vi.mocked(backend.openLatestManuscript).mockReset().mockResolvedValue(null);
    await chooseFile(w); // the database is back
    expect(w.find('[contenteditable="true"]').exists()).toBe(true);
    expect(w.find('[data-test="fatal-error"]').exists()).toBe(false);
    expect(w.find('[data-test="open-error"]').exists()).toBe(false);
    expect(w.find('[data-test="opening-error"]').exists()).toBe(false);
    w.unmount();
  });

  it('opens a chapter with the cursor in its first body paragraph, not the heading', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.openLatestManuscript).mockResolvedValueOnce(storedFixture());
    const w = mount(App, { attachTo: document.body });
    await settle();
    await new Promise((r) => setTimeout(r, 0));
    const ed = leadEditor(w).vm as unknown as {
      $: {
        setupState: {
          editor: {
            state: {
              selection: {
                $from: { parent: { type: { name: string }; attrs: Record<string, unknown> } };
              };
            };
          };
        };
      };
    };
    const parent = ed.$.setupState.editor.state.selection.$from.parent;
    expect(parent.type.name).toBe('paragraph');
    expect(parent.attrs.style ?? 'body').not.toBe('heading');
    w.unmount();
  });

  it("won't import over a manuscript whose edits aren't saved, and keeps it open", async () => {
    const backend = await import('./backend');
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await chooseFile(w);
    vi.mocked(backend.persistImport).mockClear();
    vi.mocked(backend.saveSectionUpdate).mockRejectedValue(new Error('database is locked'));
    const editor = await vi.waitFor(() => {
      const e = (
        editorSurface(w).element as unknown as { editor?: import('@tiptap/core').Editor } | null
      )?.editor;
      if (!e) throw new Error('editor not mounted yet');
      return e;
    });
    editor.commands.insertContentAt(1, 'UNSAVED ');
    await chooseFile(w);
    await flushPromises();
    expect(backend.persistImport).not.toHaveBeenCalled();
    expect(w.find('[data-test="open-error"]').text()).toBe(
      "Couldn't open synthetic.docx: some edits in the current manuscript aren't saved yet",
    );
    expect(editorSurface(w).text()).toContain('UNSAVED ');
    // Saves recover: the retry clears the banner, and now the import goes through.
    vi.mocked(backend.saveSectionUpdate).mockReset();
    vi.mocked(backend.saveSectionUpdate).mockResolvedValue(undefined);
    await new Promise((r) => setTimeout(r, 1100));
    await flushPromises();
    expect(w.find('[data-test="save-error"]').exists()).toBe(false);
    await chooseFile(w);
    expect(backend.persistImport).toHaveBeenCalledTimes(1);
    expect(w.find('[data-test="open-error"]').exists()).toBe(false);
    expect(w.find('[data-test="opening-error"]').exists()).toBe(false);
    w.unmount();
  });

  it('unmounting with unsaved edits logs, does not reject, and keeps retrying', async () => {
    const backend = await import('./backend');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await chooseFile(w);
    vi.mocked(backend.saveSectionUpdate).mockRejectedValue(new Error('database is locked'));
    const editor = await vi.waitFor(() => {
      const e = (
        editorSurface(w).element as unknown as { editor?: import('@tiptap/core').Editor } | null
      )?.editor;
      if (!e) throw new Error('editor not mounted yet');
      return e;
    });
    editor.commands.insertContentAt(1, 'BYE ');
    w.unmount();
    await flushPromises();
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    const n = vi.mocked(backend.saveSectionUpdate).mock.calls.length;
    vi.mocked(backend.saveSectionUpdate).mockReset();
    vi.mocked(backend.saveSectionUpdate).mockResolvedValue(undefined);
    await new Promise((r) => setTimeout(r, 1100));
    expect(n).toBeGreaterThan(0);
    expect(backend.saveSectionUpdate).toHaveBeenCalled(); // the retry ran after unmount
    log.mockRestore();
  });

  it('cancels the restore with a clear error if pending edits cannot be saved', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.saveSectionUpdate).mockRejectedValue(new Error('database is locked'));
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await chooseFile(w);
    const editor = await vi.waitFor(() => {
      const e = (
        editorSurface(w).element as unknown as { editor?: import('@tiptap/core').Editor } | null
      )?.editor;
      if (!e) throw new Error('editor not mounted yet');
      return e;
    });
    editor.commands.insertContentAt(1, 'UNSAVED ');
    await openSettings(w);
    await w.find('[data-test="restore-pick"]').trigger('click');
    await w.find('[data-test="restore-confirm-yes"]').trigger('click');
    await flushPromises();
    expect(backend.restoreBackup).not.toHaveBeenCalled();
    expect(w.text()).toContain('Restore cancelled');
    expect(w.text()).toContain("aren't saved yet");
    expect(w.find('[data-test="save-error"]').text()).toContain("aren't saved yet");
    expect(w.text()).not.toContain('database is locked');
    expect(editorSurface(w).exists()).toBe(true); // the session (and its edits) stays open
    vi.mocked(backend.saveSectionUpdate).mockReset();
    vi.mocked(backend.saveSectionUpdate).mockResolvedValue(undefined);
    w.unmount();
    await flushPromises();
  });

  it('does not restore until the user confirms', async () => {
    const backend = await import('./backend');
    const wrapper = mount(App);
    await flushPromises();
    await openSettings(wrapper);
    await wrapper.find('[data-test="restore-pick"]').trigger('click');
    expect(backend.restoreBackup).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="restore-confirm"]').exists()).toBe(true);
    await wrapper.find('[data-test="restore-confirm-no"]').trigger('click');
    expect(wrapper.find('[data-test="restore-confirm"]').exists()).toBe(false);
    await wrapper.find('[data-test="restore-pick"]').trigger('click');
    await wrapper.find('[data-test="restore-confirm-yes"]').trigger('click');
    await flushPromises();
    expect(backend.restoreBackup).toHaveBeenCalledWith();
    expect(wrapper.find('[data-test="backup-status"]').text()).toBe(
      'Restored. A copy of your book from just before the restore is in the backups folder.',
    );
    const notice = wrapper.find('[data-test="tokens-revoked-notice"]');
    expect(notice.text()).toContain('turned off all 2 agent key(s)');
    await wrapper.find('[data-test="tokens-notice-dismiss"]').trigger('click');
    expect(wrapper.find('[data-test="tokens-revoked-notice"]').exists()).toBe(false);
  });
});

describe('tokens-revoked notice', () => {
  async function restoreOnce(wrapper: ReturnType<typeof mount>): Promise<void> {
    await openSettings(wrapper);
    await wrapper.find('[data-test="restore-pick"]').trigger('click');
    await wrapper.find('[data-test="restore-confirm-yes"]').trigger('click');
    await flushPromises();
  }

  it('shows once after a restore that revoked tokens and stays gone after dismiss', async () => {
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.find('[data-test="tokens-revoked-notice"]').exists()).toBe(false);
    await restoreOnce(wrapper);
    const notice = wrapper.find('[data-test="tokens-revoked-notice"]');
    expect(notice.exists()).toBe(true);
    expect(notice.element.parentElement?.getAttribute('role')).toBe('status');
    expect(notice.text()).toContain('turned off all 2 agent key(s)');
    expect(notice.text()).toContain('agents are kept');
    await wrapper.find('[data-test="tokens-notice-dismiss"]').trigger('click');
    expect(wrapper.find('[data-test="tokens-revoked-notice"]').exists()).toBe(false);
    await flushPromises();
    expect(wrapper.find('[data-test="tokens-revoked-notice"]').exists()).toBe(false);
  });

  it('is not shown when no tokens were revoked', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.restoreBackup).mockResolvedValueOnce({ tokensRevoked: 0 });
    const wrapper = mount(App);
    await flushPromises();
    await restoreOnce(wrapper);
    expect(wrapper.find('[data-test="backup-status"]').text()).toContain('Restored');
    expect(wrapper.find('[data-test="tokens-revoked-notice"]').exists()).toBe(false);
  });
});

describe('backup dialogs', () => {
  it('restore asks first, then lets the backend pick the file; no path in the UI', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.restoreBackup).mockClear();
    const wrapper = mount(App);
    await flushPromises();
    await openSettings(wrapper);
    expect(wrapper.find('[data-test="restore-path"]').exists()).toBe(false);
    await wrapper.find('[data-test="restore-pick"]').trigger('click');
    await flushPromises();
    expect(backend.restoreBackup).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="restore-confirm"]').text()).not.toMatch(/[\\/]|\.zip/);
    await wrapper.find('[data-test="restore-confirm-yes"]').trigger('click');
    await flushPromises();
    expect(backend.restoreBackup).toHaveBeenCalledWith();
  });

  it('a cancelled pick changes nothing and shows nothing', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.restoreBackup).mockResolvedValueOnce(null);
    const wrapper = mount(App);
    await flushPromises();
    await openSettings(wrapper);
    await wrapper.find('[data-test="restore-pick"]').trigger('click');
    await wrapper.find('[data-test="restore-confirm-yes"]').trigger('click');
    await flushPromises();
    // #99: the status live region stays mounted; nothing is announced in it.
    expect(wrapper.get('[data-test="backup-status"]').text()).toBe('');
    expect(wrapper.find('[data-test="tokens-revoked-notice"]').exists()).toBe(false);
  });

  it.each([
    ['not-a-backup', "That file isn't a backup. Nothing was changed."],
    [
      'restore-failed',
      "The restore didn't finish, and your book wasn't changed. Please try again.",
    ],
    [
      'too-new',
      'This backup is from a newer version of swarmDraft. Update the app, then try again.',
    ],
    [
      'busy',
      'A backup, restore, or copy is already running. Wait for it to finish, then try again.',
    ],
    [
      'restore-incomplete',
      "The restore didn't finish, so swarmDraft closed your book to keep it safe. A copy from just before the restore is in the backups folder.",
    ],
    [new Error('io: C:\\secret\\b.zip denied'), "The restore didn't finish. Please try again."],
  ])('restore failure %s shows a plain notice only', async (err, text) => {
    const backend = await import('./backend');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(backend.restoreBackup).mockRejectedValueOnce(err);
    const wrapper = mount(App);
    await flushPromises();
    await openSettings(wrapper);
    await wrapper.find('[data-test="restore-pick"]').trigger('click');
    await wrapper.find('[data-test="restore-confirm-yes"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="backup-status"]').text()).toBe(text);
    log.mockRestore();
  });

  it('backup lets the backend choose the destination and shows no path', async () => {
    const backend = await import('./backend');
    const wrapper = mount(App);
    await flushPromises();
    await openSettings(wrapper);
    await wrapper.find('[data-test="backup-button"]').trigger('click');
    await flushPromises();
    expect(backend.createBackup).toHaveBeenCalledWith();
    expect(wrapper.find('[data-test="backup-status"]').text()).toBe('Backup saved.');
  });

  it('a backup refused as busy says another one is running (#86)', async () => {
    const backend = await import('./backend');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(backend.createBackup).mockRejectedValueOnce('busy');
    const wrapper = mount(App);
    await flushPromises();
    await openSettings(wrapper);
    await wrapper.find('[data-test="backup-button"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="backup-status"]').text()).toBe(
      'A backup, restore, or copy is already running. Wait for it to finish, then try again.',
    );
    log.mockRestore();
  });
});

describe('recovery notice', () => {
  const notice = {
    id: 'n1',
    corruptFile: null,
    folder: 'C:\\data\\recovery-1',
    moved: ['files', 'files-old-7'],
    snapshot: 'C:\\data\\backups\\pre-restore-1.zip',
    filesDir: 'C:\\data\\files',
    reason: 'restore journal is unreadable',
    retryPending: false,
    saveError: null,
  };

  it('shows plain wording with the folder and snapshot, and clears only on Dismiss', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.getRecoveryNotices).mockResolvedValueOnce([notice]);
    const wrapper = mount(App);
    await flushPromises();
    const n = wrapper.find('[data-test="recovery-notice"]');
    expect(n.exists()).toBe(true);
    expect(n.text()).toContain('Some attachments may be missing');
    expect(n.text()).toContain('C:\\data\\recovery-1');
    expect(n.text()).toContain('C:\\data\\files');
    expect(n.text()).toContain('pre-restore-1.zip');
    expect(backend.dismissRecoveryNotices).not.toHaveBeenCalled();
    await wrapper.find('[data-test="recovery-notice-dismiss"]').trigger('click');
    await flushPromises();
    expect(backend.dismissRecoveryNotices).toHaveBeenCalledWith(['n1']);
    expect(wrapper.find('[data-test="recovery-notice"]').exists()).toBe(false);
  });

  it('does not say moved when nothing was moved, and shows a save error', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.getRecoveryNotices).mockResolvedValueOnce([
      { ...notice, folder: null, moved: [], retryPending: true, saveError: 'disk full' },
    ]);
    const wrapper = mount(App);
    await flushPromises();
    const n = wrapper.find('[data-test="recovery-notice"]');
    expect(n.text()).not.toContain('Moved to');
    expect(n.text()).toContain('try again');
    expect(wrapper.find('[data-test="recovery-notice-save-error"]').text()).toContain(
      'Your computer is almost full',
    );
  });

  it('shows where a corrupt notice file was kept', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.getRecoveryNotices).mockResolvedValueOnce([
      { ...notice, id: 'c', corruptFile: 'C:\\data\\recovery-notice.corrupt-1.json' },
    ]);
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.find('[data-test="recovery-notice-corrupt"]').text()).toContain(
      'recovery-notice.corrupt-1.json',
    );
  });

  it('keeps the notice if Dismiss fails', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.getRecoveryNotices).mockResolvedValueOnce([notice]);
    vi.mocked(backend.dismissRecoveryNotices).mockRejectedValueOnce(new Error('locked'));
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.find('[data-test="recovery-notice-dismiss"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="recovery-notice"]').text()).toContain("Couldn't dismiss");
  });

  it('is absent when recovery left no notice', async () => {
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.find('[data-test="recovery-notice"]').exists()).toBe(false);
  });
});

describe('migration notice (#71)', () => {
  it('shows migration text on its own, never as restore recovery, and dismisses', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.getMigrationNotices).mockResolvedValueOnce([
      { id: 'migration-copy-failed', kind: 'warn', text: 'Old documents are safe.' },
    ]);
    const wrapper = mount(App);
    await flushPromises();
    const n = wrapper.find('[data-test="migration-notice"]');
    expect(n.text()).toContain('Old documents are safe.');
    expect(wrapper.find('[data-test="recovery-notice"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('A restore was interrupted');
    await wrapper.find('[data-test="migration-notice-dismiss"]').trigger('click');
    await flushPromises();
    expect(backend.dismissMigrationNotices).toHaveBeenCalledWith(['migration-copy-failed']);
    expect(wrapper.find('[data-test="migration-notice"]').exists()).toBe(false);
  });
});

describe('migration notice banner (#71)', () => {
  it('keeps the same live regions mounted, dismisses one kind and leaves the other', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.dismissMigrationNotices).mockClear();
    vi.mocked(backend.getMigrationNotices).mockResolvedValueOnce([
      { id: 'migration-kept', kind: 'info', text: 'Old files kept.' },
      { id: 'migration-locked', kind: 'warn', text: 'Close the old app.' },
      { id: 'migration-copy-failed', kind: 'warn', text: 'Copy failed.' },
    ]);
    const wrapper = mount(App);
    const alertBefore = wrapper.find('[data-test="migration-notice-warn-region"]').element;
    const statusBefore = wrapper.find('[data-test="migration-notice-info-region"]').element;
    expect(alertBefore).toBeTruthy();
    await flushPromises();
    const alert = wrapper.find('[data-test="migration-notice-warn-region"]');
    expect(alert.element).toBe(alertBefore);
    expect(alert.attributes('role')).toBe('alert');
    expect(alert.text()).toContain('Close the old app.');
    expect(alert.text()).toContain('Copy failed.');
    await alert.find('[data-test="migration-notice-dismiss"]').trigger('click');
    await flushPromises();
    expect(backend.dismissMigrationNotices).toHaveBeenCalledWith([
      'migration-locked',
      'migration-copy-failed',
    ]);
    const after = wrapper.find('[data-test="migration-notice-warn-region"]');
    expect(after.element).toBe(alertBefore);
    expect(after.text()).toBe('');
    const status = wrapper.find('[data-test="migration-notice-info-region"]');
    expect(status.element).toBe(statusBefore);
    expect(status.attributes('role')).toBe('status');
    expect(status.text()).toContain('Old files kept.');
  });

  it('renders below the title bar, not inside or over it', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.getMigrationNotices).mockResolvedValueOnce([
      { id: 'migration-kept', kind: 'info', text: 'Old files kept.' },
    ]);
    const wrapper = mount(App);
    await flushPromises();
    await openSettings(wrapper);
    const region = wrapper.find('[data-test="migration-notice-region"]').element;
    const topbar = wrapper.find('header.topbar').element;
    expect(topbar.contains(region)).toBe(false);
    expect(topbar.nextElementSibling).toBe(region);
  });
});

describe('restore closes the open manuscript', () => {
  async function restore(w: ReturnType<typeof mount>) {
    await openSettings(w);
    await w.find('[data-test="restore-pick"]').trigger('click');
    await w.find('[data-test="restore-confirm-yes"]').trigger('click');
    await settle();
  }

  it('drops the pre-restore session and editor, and ignores later edits to the old docs', async () => {
    const { w, session } = await withManuscript();
    expect(editorSurface(w).exists()).toBe(true);
    const before = session.outline.value;
    await restore(w);
    expect(w.find('[data-test="no-manuscript"]').exists()).toBe(true);
    expect(editorSurface(w).exists()).toBe(false);
    expect(w.findAll('.row')).toHaveLength(0);

    // The old docs keep changing (e.g. a late peer update); nothing reaches the UI or the session.
    const outline = readStructure(session.manuscript);
    writeStructure(
      session.manuscript,
      outline.map((s, i) => (i === 0 ? { ...s, title: 'Stale write' } : s)),
    );
    await settle();
    expect(session.outline.value).toBe(before);
    expect(w.text()).not.toContain('Stale write');
    expect(editorSurface(w).exists()).toBe(false);
    w.unmount();
  });

  it('keeps the session when the restore fails', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.restoreBackup).mockRejectedValueOnce(new Error('bad zip'));
    const { w } = await withManuscript();
    await restore(w);
    expect(w.find('[data-test="backup-status"]').text()).toBe(
      "The restore didn't finish. Please try again.",
    );
    expect(w.find('[data-test="no-manuscript"]').exists()).toBe(false);
    expect(editorSurface(w).exists()).toBe(true);
    w.unmount();
  });

  it('closes the session when the restore is incomplete (#86)', async () => {
    const backend = await import('./backend');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(backend.restoreBackup).mockRejectedValueOnce('restore-incomplete');
    const { w } = await withManuscript();
    await restore(w);
    expect(w.find('[data-test="backup-status"]').text()).toBe(
      "The restore didn't finish, so swarmDraft closed your book to keep it safe. A copy from just before the restore is in the backups folder.",
    );
    expect(editorSurface(w).exists()).toBe(false);
    log.mockRestore();
    w.unmount();
  });

  it('keeps the session when the restore failed cleanly (#86)', async () => {
    const backend = await import('./backend');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(backend.restoreBackup).mockRejectedValueOnce('restore-failed');
    const { w } = await withManuscript();
    await restore(w);
    expect(editorSurface(w).exists()).toBe(true);
    log.mockRestore();
    w.unmount();
  });
});

describe('home screen', () => {
  it('shows the welcome once, then the open screen, and remembers it', async () => {
    localStorage.removeItem('coauthor.welcomed');
    const w = mount(App);
    await flushPromises();
    expect(w.find('[data-test="home-welcome"]').text()).toContain('Welcome to swarmDraft');
    expect(w.find('[data-test="open-manuscript"]').exists()).toBe(false);
    await w.find('[data-test="get-started"]').trigger('click');
    expect(w.find('[data-test="home-open"]').text()).toContain("Let's open your book");
    expect(localStorage.getItem('coauthor.welcomed')).toBe('1');
    w.unmount();
    const again = mount(App);
    await flushPromises();
    expect(again.find('[data-test="home-welcome"]').exists()).toBe(false);
    expect(again.find('[data-test="open-manuscript"]').text()).toContain('Open my Word manuscript');
    again.unmount();
  });

  it('"Open my Word manuscript" opens the Word file picker', async () => {
    localStorage.setItem('coauthor.welcomed', '1');
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const input = w.find('[data-test="open-docx"]').element as HTMLInputElement;
    const click = vi.spyOn(input, 'click').mockImplementation(() => {});
    await w.find('[data-test="open-manuscript"]').trigger('click');
    expect(click).toHaveBeenCalledTimes(1);
    expect(input.accept).toContain('.docx');
    w.unmount();
  });

  it('opens a manuscript dropped on the drop zone', async () => {
    localStorage.setItem('coauthor.welcomed', '1');
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const file = new File([bytes()], 'synthetic.docx');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes().buffer });
    await w.find('[data-test="drop-zone"]').trigger('drop', { dataTransfer: { files: [file] } });
    await settle();
    expect(w.find('[data-test="home"]').exists()).toBe(false);
    expect(w.findAll('.row').length).toBeGreaterThan(0);
    w.unmount();
  });

  it('keeps backup, restore and agents behind Settings', async () => {
    const w = mount(App);
    await flushPromises();
    expect(w.find('[data-test="backup"]').exists()).toBe(false);
    expect(w.find('[data-test="app-info"]').exists()).toBe(false);
    await w.find('[data-test="settings-open"]').trigger('click');
    expect(w.find('[data-test="backup"]').exists()).toBe(true);
    expect(w.find('[data-test="app-info"]').exists()).toBe(true);
    await w.find('[data-test="settings-close"]').trigger('click');
    expect(w.find('[data-test="settings"]').exists()).toBe(false);
    w.unmount();
  });

  it('moves focus to the open button after Get started', async () => {
    localStorage.removeItem('coauthor.welcomed');
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await w.find('[data-test="get-started"]').trigger('click');
    await settle();
    expect(document.activeElement).toBe(w.find('[data-test="open-manuscript"]').element);
    w.unmount();
  });

  it('rejects a dropped file that is not Word, keeping the open book', async () => {
    const backend = await import('./backend');
    const persist = vi.mocked(backend.persistImport);
    const { w, session } = await withManuscript();
    persist.mockClear();
    await w.get('[data-test="app-menu-trigger"]').trigger('click');
    await w.find('[data-test="app-menu-open"]').trigger('click');
    const bad = new File(['hello'], 'notes.txt');
    await w.find('[data-test="drop-zone"]').trigger('drop', { dataTransfer: { files: [bad] } });
    await settle();
    expect(w.find('[data-test="open-error"]').text()).toBe(
      "That file isn't a Word manuscript. Please choose a Word file.",
    );
    expect(persist).not.toHaveBeenCalled();
    expect(session.closed).toBe(false);
    await w.find('[data-test="open-cancel"]').trigger('click');
    expect(editorSurface(w).exists()).toBe(true);
    w.unmount();
  });

  it('opens a second manuscript from inside an open one', async () => {
    const { w } = await withManuscript();
    expect(w.find('[data-test="home"]').exists()).toBe(false);
    await w.get('[data-test="app-menu-trigger"]').trigger('click');
    await w.find('[data-test="app-menu-open"]').trigger('click');
    expect(w.find('[data-test="home-open"]').exists()).toBe(true);
    await chooseFile(w);
    expect(w.find('[data-test="home"]').exists()).toBe(false);
    expect(w.findAll('.row').length).toBeGreaterThan(0);
    w.unmount();
  });

  it('skips the welcome for a returning user whose book reopens', async () => {
    localStorage.removeItem('coauthor.welcomed');
    const { w } = await withManuscript();
    expect(localStorage.getItem('coauthor.welcomed')).toBe('1');
    w.unmount();
  });

  it('focuses Settings when it opens and closes it on Esc', async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await w.find('[data-test="settings-open"]').trigger('click');
    await settle();
    const panel = w.find('[data-test="settings"]');
    expect(document.activeElement).toBe(panel.element);
    await panel.trigger('keydown', { key: 'Escape' });
    expect(w.find('[data-test="settings"]').exists()).toBe(false);
    w.unmount();
  });

  it('lets OS file drops reach the page (Tauri drag-drop off)', () => {
    const conf = JSON.parse(
      readFileSync(resolve(__dirname, '../src-tauri/tauri.conf.json'), 'utf8'),
    ) as { app: { windows: { dragDropEnabled?: boolean }[] } };
    expect(conf.app.windows[0]!.dragDropEnabled).toBe(false);
  });

  it('returns focus to the Settings button when Settings closes', async () => {
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    const button = w.find('[data-test="settings-open"]');
    await button.trigger('click');
    await settle();
    await w.find('[data-test="settings"]').trigger('keydown', { key: 'Escape' });
    await settle();
    expect(document.activeElement).toBe(button.element);
    await button.trigger('click');
    await settle();
    await w.find('[data-test="settings-close"]').trigger('click');
    await settle();
    expect(document.activeElement).toBe(button.element);
    w.unmount();
  });

  it('swallows a file dropped outside the drop zone without importing or closing', async () => {
    const backend = await import('./backend');
    const persist = vi.mocked(backend.persistImport);
    const { w, session } = await withManuscript();
    persist.mockClear();
    const file = new File(['x'], 'other.docx');
    for (const target of [editorSurface(w).element, w.find('.topbar').element]) {
      for (const type of ['dragover', 'drop']) {
        const ev = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'dataTransfer', { value: { files: [file] } });
        target.dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(true);
      }
    }
    await settle();
    expect(persist).not.toHaveBeenCalled();
    expect(session.closed).toBe(false);
    expect(editorSurface(w).exists()).toBe(true);
    w.unmount();
  });

  it('removes the window drop guard on unmount', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const w = mount(App);
    await flushPromises();
    const added = add.mock.calls.filter(([t]) => t === 'drop' || t === 'dragover');
    expect(added).toHaveLength(2);
    w.unmount();
    for (const [type, fn] of added) expect(remove).toHaveBeenCalledWith(type, fn);
    add.mockRestore();
    remove.mockRestore();
  });
});

describe('App UI shells (Part of #36)', () => {
  it('shows the book title only in the top bar and per-section word counts (#107)', async () => {
    const { w, session } = await withManuscript();
    expect(w.find('[data-test="breadcrumb"]').exists()).toBe(false);
    expect(w.find('.topbar__name').text()).toBe(session.title);
    expect(w.find('[data-test="continuous-manuscript"]').exists()).toBe(true);
    const outline = readStructure(session.manuscript);
    const chapter = outline.find((s) => s.kind === 'chapter')!;
    await w.find(`[data-test="section-${chapter.id}"]`).trigger('click');
    await settle();
    const counts = w.findAll('[data-test="word-count"]');
    expect(counts).toHaveLength(outline.length);
    const words = docWordCount(session.sections.get(chapter.docId)!);
    expect(
      w
        .find(`[data-test="section-${chapter.id}"] [data-test="word-count"]`)
        .attributes('aria-label'),
    ).toBe(`${words} words`);
    expect(w.find('[data-test="new-chapter"]').exists()).toBe(false);
    w.unmount();
  });

  it('focus mode from the editor hides the outline and top bar', async () => {
    const { w } = await withManuscript();
    await w.find('[data-test="focus-mode"]').trigger('click');
    await settle();
    expect(w.find('#chapter-navigator').isVisible()).toBe(false);
    expect(w.find('.topbar').isVisible()).toBe(false);
    await w.find('[data-test="focus-exit"]').trigger('click');
    await settle();
    expect(w.find('#chapter-navigator').isVisible()).toBe(true);
    w.unmount();
  });
});

describe('full-width toolbar (#84)', () => {
  // The toolbar row sits between the title bar and the panel row, as a sibling of both, so it
  // spans the window and the outline / review panels start below it.
  const order = (w: ReturnType<typeof mount>) => {
    const main = w.get('main.shell').element;
    const kids = [...main.children];
    return {
      topbar: kids.indexOf(w.get('.topbar').element),
      row: kids.indexOf(w.get('[data-test="toolbar-row"]').element),
      workspace: kids.indexOf(w.get('[data-test="workspace"]').element),
    };
  };
  const toolbarIn = (w: ReturnType<typeof mount>, sel: string) =>
    w.get(sel).element.contains(w.get('[data-test="tb-navigator"]').element);

  it('renders the toolbar in its own row under the title bar, before and outside the panel row', async () => {
    const { w } = await withManuscript();
    const o = order(w);
    expect(o.topbar).toBeGreaterThanOrEqual(0);
    expect(o.row).toBeGreaterThan(o.topbar);
    expect(o.workspace).toBeGreaterThan(o.row);
    expect(toolbarIn(w, '[data-test="toolbar-row"]')).toBe(true);
    expect(toolbarIn(w, '[data-test="workspace"]')).toBe(false);
    // The panels stay in the panel row, never in the toolbar row.
    const row = w.get('[data-test="toolbar-row"]').element;
    expect(row.contains(w.get('#chapter-navigator').element)).toBe(false);
    expect(row.contains(w.get('[data-test="review"]').element)).toBe(false);
    expect(
      w.get('[data-test="workspace"]').element.contains(w.get('#chapter-navigator').element),
    ).toBe(true);
    w.unmount();
  });

  it('keeps the toolbar in the row when the outline and review panels are toggled', async () => {
    const { w } = await withManuscript();
    await w.get('[data-test="tb-navigator"]').trigger('click');
    await w.get('[data-test="tb-review"]').trigger('click');
    await settle();
    expect(toolbarIn(w, '[data-test="toolbar-row"]')).toBe(true);
    await w.get('[data-test="tb-navigator"]').trigger('click');
    await w.get('[data-test="tb-review"]').trigger('click');
    await settle();
    expect(toolbarIn(w, '[data-test="toolbar-row"]')).toBe(true);
    expect(toolbarIn(w, '[data-test="workspace"]')).toBe(false);
    w.unmount();
  });

  it('focus mode empties the toolbar row and exiting brings the toolbar back to it', async () => {
    const { w } = await withManuscript();
    await w.get('[data-test="focus-mode"]').trigger('click');
    await settle();
    expect(w.find('[data-test="tb-navigator"]').exists()).toBe(false);
    expect(w.get('[data-test="toolbar-row"]').element.children).toHaveLength(0);
    await w.get('[data-test="focus-exit"]').trigger('click');
    await settle();
    expect(toolbarIn(w, '[data-test="toolbar-row"]')).toBe(true);
    w.unmount();
  });

  it('Ctrl+F from a toolbar button still opens Find', async () => {
    const { w } = await withManuscript();
    await w.get('[data-test="tb-bold"]').trigger('keydown', { key: 'f', ctrlKey: true });
    await settle();
    expect(w.find('[data-test="find-panel"]').exists()).toBe(true);
    w.unmount();
  });

  it('Ctrl+Shift+F from a teleported toolbar button toggles focus mode exactly once', async () => {
    const { w } = await withManuscript();
    const ev = new KeyboardEvent('keydown', {
      key: 'F',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    const pd = vi.spyOn(ev, 'preventDefault');
    w.get('[data-test="tb-bold"]').element.dispatchEvent(ev);
    await settle();
    expect(pd).toHaveBeenCalledTimes(1);
    expect(leadFocusModeOn(w)).toBe(true);
    w.unmount();
  });
});

describe('focus mode started from the toolbar (#87 QA)', () => {
  const key = (el: Element, init: KeyboardEventInit) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

  it('moves focus into the page, and Ctrl+Shift+F from there exits', async () => {
    const { w } = await withManuscript();
    await w.get('[data-test="focus-mode"]').trigger('click');
    await settle();
    expect(leadFocusModeOn(w)).toBe(true);
    expect(document.activeElement?.closest('.ProseMirror')).not.toBeNull();
    key(document.activeElement!, { key: 'F', ctrlKey: true, shiftKey: true });
    await settle();
    expect(leadFocusModeOff(w)).toBe(true);
    w.unmount();
  });

  it('Escape and Ctrl+Shift+F exit even with focus on the body, each exactly once', async () => {
    const { w } = await withManuscript();
    for (const init of [{ key: 'Escape' }, { key: 'F', ctrlKey: true, shiftKey: true }]) {
      await w.get('[data-test="focus-mode"]').trigger('click');
      await settle();
      (document.activeElement as HTMLElement | null)?.blur();
      expect(document.activeElement).toBe(document.body);
      key(document.body, init);
      await settle();
      expect(leadFocusModeOff(w)).toBe(true);
    }
    w.unmount();
  });
});

describe('context menu in focus mode (#87 QA)', () => {
  it('Escape with the menu open but focus on the body also closes only the menu', async () => {
    const { w } = await withManuscript();
    await w.get('[data-test="focus-mode"]').trigger('click');
    await settle();
    await proseFind(w).trigger('contextmenu', { clientX: 50, clientY: 50 });
    await settle();
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await settle();
    expect(w.find('[data-test="context-menu"]').exists()).toBe(false);
    expect(leadFocusModeOn(w)).toBe(true);
  });

  it('Escape with the menu open closes only the menu and stays in focus mode', async () => {
    const { w } = await withManuscript();
    await w.get('[data-test="focus-mode"]').trigger('click');
    await settle();
    await proseFind(w).trigger('contextmenu', { clientX: 50, clientY: 50 });
    await settle();
    const menu = w.get('[data-test="context-menu"]');
    const target = (menu.element.querySelector('[role=menuitem]') as HTMLElement) ?? menu.element;
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await settle();
    expect(w.find('[data-test="context-menu"]').exists()).toBe(false);
    expect(leadFocusModeOn(w)).toBe(true);
    // With the menu closed, Escape exits focus mode as before.
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await settle();
    expect(leadFocusModeOff(w)).toBe(true);
  });
});

describe('Find in focus mode (#94)', () => {
  const key = (el: Element, init: KeyboardEventInit) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  const enterFocus = async (w: ReturnType<typeof mount>) => {
    await w.get('[data-test="focus-mode"]').trigger('click');
    await settle();
    expect(leadFocusModeOn(w)).toBe(true);
  };
  const find = (w: ReturnType<typeof mount>) => w.find('[data-test="find-panel"]').exists();
  const focused = (w: ReturnType<typeof mount>) => leadFocusModeOn(w);

  const openFindFromPage = async (w: ReturnType<typeof mount>) => {
    await enterFocus(w);
    const pm = proseDom(w);
    pm.focus();
    key(pm, { key: 'f', ctrlKey: true });
    await settle();
    expect(document.activeElement).toBe(w.get('[data-test="find-input"]').element);
  };
  const focusInPage = (w: ReturnType<typeof mount>) => proseDom(w).contains(document.activeElement);

  it('Escape in the find input returns focus to the page (focus mode)', async () => {
    const { w } = await withManuscript();
    await openFindFromPage(w);
    key(w.get('[data-test="find-input"]').element, { key: 'Escape' });
    await settle();
    expect(find(w)).toBe(false);
    expect(focusInPage(w)).toBe(true);
  });

  it('the Find close button returns focus to the page (focus mode)', async () => {
    const { w } = await withManuscript();
    await openFindFromPage(w);
    await w.get('[data-test="find-close"]').trigger('click');
    await settle();
    expect(find(w)).toBe(false);
    expect(focusInPage(w)).toBe(true);
  });

  it('Ctrl+F from the page opens Find in focus mode and keeps focus mode on', async () => {
    const { w } = await withManuscript();
    await enterFocus(w);
    key(proseDom(w), { key: 'f', ctrlKey: true });
    await settle();
    expect(find(w)).toBe(true);
    expect(focused(w)).toBe(true);
  });

  it('Ctrl+F with focus on the body opens Find in focus mode', async () => {
    const { w } = await withManuscript();
    await enterFocus(w);
    (document.activeElement as HTMLElement | null)?.blur();
    key(document.body, { key: 'f', ctrlKey: true });
    await settle();
    expect(find(w)).toBe(true);
    expect(focused(w)).toBe(true);
  });

  it('Escape closes Find first; a later Escape exits focus mode; Find does not pop up after', async () => {
    const { w } = await withManuscript();
    await enterFocus(w);
    key(proseDom(w), { key: 'f', ctrlKey: true });
    await settle();
    key(w.get('[data-test="find-input"]').element, { key: 'Escape' });
    await settle();
    expect(find(w)).toBe(false);
    expect(focused(w)).toBe(true);
    key(document.activeElement ?? document.body, { key: 'Escape' });
    await settle();
    expect(focused(w)).toBe(false);
    expect(find(w)).toBe(false);
  });

  it('Escape with Find open and focus back in the page closes Find, not focus mode', async () => {
    const { w } = await withManuscript();
    await enterFocus(w);
    key(proseDom(w), { key: 'f', ctrlKey: true });
    await settle();
    key(proseDom(w), { key: 'Escape' });
    await settle();
    expect(find(w)).toBe(false);
    expect(focused(w)).toBe(true);
  });

  it('Escape with Find open and focus on the body closes Find, not focus mode', async () => {
    const { w } = await withManuscript();
    await enterFocus(w);
    key(proseDom(w), { key: 'f', ctrlKey: true });
    await settle();
    (document.activeElement as HTMLElement | null)?.blur();
    key(document.body, { key: 'Escape' });
    await settle();
    expect(find(w)).toBe(false);
    expect(focused(w)).toBe(true);
  });
});

describe('book-open toast (ob7)', () => {
  it('keeps one persistent polite live region: same node before open, after open, after dismiss (#79)', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.openLatestManuscript).mockResolvedValueOnce(null);
    const w = mount(App, { attachTo: document.body });
    await settle();
    const region = w.get('[data-test="toast-region"]');
    expect(region.attributes('role')).toBe('status');
    expect(region.attributes('aria-live')).toBe('polite');
    expect(region.text()).toBe('');
    const node = region.element;
    await chooseFile(w);
    expect(w.get('[data-test="toast-region"]').element).toBe(node);
    expect(node.textContent).toContain('Your book is open.');
    await w.get('[data-test="toast-dismiss"]').trigger('click');
    expect(w.get('[data-test="toast-region"]').element).toBe(node);
    expect(node.isConnected).toBe(true);
    expect(node.textContent?.trim()).toBe('');
    w.unmount();
  });

  it('shows after a successful import and says the original is untouched', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.openLatestManuscript).mockResolvedValueOnce(null);
    const w = mount(App, { attachTo: document.body });
    await settle();
    expect(w.find('[data-test="toast"]').exists()).toBe(false);
    await chooseFile(w);
    const toast = w.find('[data-test="open-toast"] [data-test="toast"]');
    expect(toast.exists()).toBe(true);
    expect(w.get('[data-test="toast-region"]').attributes('aria-live')).toBe('polite');
    expect(toast.text()).toContain('Your book is open.');
    expect(toast.text()).toContain('original file is untouched');
    w.unmount();
  });

  it('re-importing while the toast is up empties the same region, then re-fills it (#82)', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.openLatestManuscript).mockResolvedValueOnce(null);
    const w = mount(App, { attachTo: document.body });
    await settle();
    await chooseFile(w);
    const node = w.get('[data-test="open-toast"] [data-test="toast-region"]').element;
    expect(node.textContent).toContain('original file is untouched');
    // Each mutation record is one DOM change; replay them to get the region's text over time.
    const steps: string[] = [];
    const isToast = (n: Node) => n instanceof HTMLElement && n.dataset.test === 'toast';
    const obs = new MutationObserver((records) => {
      for (const r of records) {
        if ([...r.removedNodes].some(isToast)) steps.push('');
        if ([...r.addedNodes].some(isToast)) steps.push('text');
      }
    });
    obs.observe(node, { childList: true, subtree: true, characterData: true });
    await chooseFile(w);
    await new Promise((r) => setTimeout(r, 0));
    obs.disconnect();
    expect(w.get('[data-test="open-toast"] [data-test="toast-region"]').element).toBe(node);
    // The region went empty, then got the text back (a fresh announcement), on the same node.
    expect(steps.join(',')).toMatch(/(^|,),text$/);
    expect(node.textContent).toContain('original file is untouched');
    w.unmount();
  });

  it('does not show when the import fails', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.openLatestManuscript).mockResolvedValueOnce(storedFixture());
    const w = mount(App, { attachTo: document.body });
    await settle();
    vi.mocked(backend.persistImport).mockRejectedValueOnce('disk full');
    vi.mocked(backend.openLatestManuscript).mockResolvedValueOnce(storedFixture());
    await chooseFile(w);
    expect(w.find('[data-test="open-error"]').exists()).toBe(true);
    expect(w.find('[data-test="toast"]').exists()).toBe(false);
    w.unmount();
  });

  it('does not show when the last book reopens at startup', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.openLatestManuscript).mockResolvedValueOnce(storedFixture());
    const w = mount(App, { attachTo: document.body });
    await settle();
    expect(w.find('[contenteditable="true"]').exists()).toBe(true);
    expect(w.find('[data-test="toast"]').exists()).toBe(false);
    w.unmount();
  });

  it('a failed import within the 8 s clears the earlier success toast (fake timers)', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.openLatestManuscript).mockResolvedValueOnce(null);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const w = mount(App, { attachTo: document.body });
      await settle();
      await chooseFile(w);
      expect(w.find('[data-test="toast"]').exists()).toBe(true);
      await vi.advanceTimersByTimeAsync(2000);
      // A read failure: nothing is closed or reopened, so only the failure path's clear runs.
      const input = w.find('[data-test="open-docx"]');
      const file = new File([bytes()], 'broken.docx');
      Object.defineProperty(file, 'arrayBuffer', { value: async () => Promise.reject('io') });
      Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
      await input.trigger('change');
      await settle();
      expect(w.find('[data-test="open-error"]').exists()).toBe(true);
      // Still well inside the 8 s auto-close: only the failure path can have cleared it.
      expect(w.find('[data-test="toast"]').exists()).toBe(false);
      w.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('opening another book clears the previous book-open toast', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.openLatestManuscript).mockResolvedValueOnce(null);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const w = mount(App, { attachTo: document.body });
      await settle();
      await chooseFile(w);
      expect(w.find('[data-test="toast"]').exists()).toBe(true);
      const other = sessionFromDocx(bytes(), 'm2');
      (w.vm as unknown as { open: (s: typeof other) => void }).open(other);
      await settle();
      expect(w.find('[data-test="toast"]').exists()).toBe(false);
      w.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes with Got it, and on its own after a few seconds', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.openLatestManuscript).mockResolvedValueOnce(null);
    const w = mount(App, { attachTo: document.body });
    await settle();
    await chooseFile(w);
    await w.find('[data-test="toast-dismiss"]').trigger('click');
    expect(w.find('[data-test="toast"]').exists()).toBe(false);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await chooseFile(w);
    expect(w.find('[data-test="toast"]').exists()).toBe(true);
    await vi.advanceTimersByTimeAsync(8000);
    expect(w.find('[data-test="toast"]').exists()).toBe(false);
    vi.useRealTimers();
    w.unmount();
  });
});

describe('title bar book menu (#104)', () => {
  const styles = () => {
    const sfc = readFileSync(resolve(__dirname, 'App.vue'), 'utf8');
    return [...sfc.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
  };

  it('uses one hamburger+logo trigger with aria-haspopup and a 40px hit area', async () => {
    const css = styles();
    expect(css).toMatch(/\.topbar__trigger[^}]*min-height:\s*var\(--ct-space-10\)/);
    expect(css).toMatch(/\.topbar__trigger[^}]*min-width:\s*var\(--ct-space-10\)/);
    const w = mount(App);
    await flushPromises();
    expect(w.findAll('[data-test="app-menu"]')).toHaveLength(1);
    expect(w.text()).not.toContain('⋯');
    const trigger = w.get('[data-test="app-menu-trigger"]');
    expect(trigger.attributes('aria-haspopup')).toBe('menu');
    const hamburger = trigger.find('svg[data-icon="menu"]');
    const logo = trigger.find('[data-test="app-logo"]');
    expect(hamburger.exists()).toBe(true);
    expect(logo.exists()).toBe(true);
    expect(
      hamburger.element.compareDocumentPosition(logo.element) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    w.unmount();
  });

  it('opens the book menu from the shared trigger (hamburger and logo)', async () => {
    const w = mount(App);
    await flushPromises();
    const menu = w.get('[data-test="app-menu"]');
    expect(menu.attributes('open')).toBeUndefined();
    await w.get('[data-test="app-menu-trigger"]').trigger('click');
    await settle();
    expect(menu.attributes('open')).toBeDefined();
    expect(w.find('[data-test="settings-open"]').exists()).toBe(true);
    w.unmount();
  });

  it('lists New, Open, Recent, and Settings in the book menu (#104 PM)', async () => {
    const w = mount(App);
    await flushPromises();
    await w.get('[data-test="app-menu-trigger"]').trigger('click');
    await settle();
    const labels = w.findAll('[data-test="app-menu"] [role=menuitem]').map((b) => b.text());
    expect(labels.some((l) => l.startsWith('New') && l.includes('Ctrl+N'))).toBe(true);
    expect(labels.some((l) => l.startsWith('Open') && l.includes('Ctrl+O'))).toBe(true);
    expect(labels.some((l) => l.startsWith('Recent'))).toBe(true);
    expect(labels.some((l) => l.startsWith('Settings') && l.includes('Ctrl+,'))).toBe(true);
    expect(w.get('[data-test="app-menu-new"]').find('[data-icon="plus"]').exists()).toBe(true);
    w.unmount();
  });

  it('binds Ctrl+O to open the book picker (#104 Designer)', async () => {
    const { w } = await withManuscript();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, bubbles: true }));
    await settle();
    expect(w.find('[data-test="home-open"]').exists()).toBe(true);
    w.unmount();
  });

  it('Recent submenu toggles without closing the book menu; picking a book closes it (#104)', async () => {
    const backend = await import('./backend');
    const stored = storedFixture();
    const other = {
      ...stored,
      manuscript: { ...stored.manuscript, id: 'other-book', title: 'Other' },
    };
    vi.mocked(backend.listManuscripts).mockResolvedValue([
      {
        id: other.manuscript.id,
        title: other.manuscript.title,
        createdAt: '',
        numberingStyle: 'chapter_arabic',
      },
    ]);
    vi.mocked(backend.loadManuscript).mockResolvedValueOnce(other);
    const { w } = await withManuscript();
    const menu = w.get('[data-test="app-menu"]');
    await w.get('[data-test="app-menu-trigger"]').trigger('click');
    await settle();
    await w.get('[data-test="app-menu-recent"]').trigger('click');
    await settle();
    expect(menu.attributes('open')).toBeDefined();
    await w.get(`[data-test="app-menu-recent-${other.manuscript.id}"]`).trigger('click');
    await settle();
    expect(menu.attributes('open')).toBeUndefined();
    w.unmount();
  });

  it('keeps the title bar draggable except the menu trigger (Windows)', () => {
    const css = styles();
    expect(css).toMatch(/\.topbar\s*\{[^}]*-webkit-app-region:\s*drag/);
    expect(css).toMatch(/\.topbar__menu\s*\{[^}]*-webkit-app-region:\s*no-drag/);
  });
});

describe('product name in App.vue', () => {
  it('never hardcodes the old product name and shows the brand constant in the topbar', async () => {
    const src = readFileSync(resolve(__dirname, 'App.vue'), 'utf8');
    expect(src).not.toMatch(/coAuthor/);
    const w = mount(App);
    await flushPromises();
    expect(w.find('.topbar__name').text()).toBe(PRODUCT_NAME);
    w.unmount();
  });
});

describe('author color slots per manuscript (#72)', () => {
  it('opening a different manuscript restarts collab slot numbering', async () => {
    const { collabSlotOf } = await import('./author-colors');
    const { w } = await withManuscript();
    const alice = collabSlotOf('person:Alice');
    const bob = collabSlotOf('person:Bob');
    expect(bob).toBeGreaterThan(alice);
    const other = sessionFromDocx(bytes(), 'm2');
    (w.vm as unknown as { open: (s: typeof other) => void }).open(other);
    await settle();
    // resetCollabSlots on open restarts numbering (#72); suggestion marks may take lower slots first (#48).
    expect(collabSlotOf('person:Bob')).toBeLessThan(bob);
    w.unmount();
  });
});

describe('App outline auto-collapse on a narrow desk (#92)', () => {
  const layout = (reviewShown: boolean, deskWidth: number) => ({
    reviewShown,
    deskWidth,
    marginNotes: false,
  });

  it('closes the outline when the editor reports a too-narrow desk, reopens on review close', async () => {
    const { w } = await withManuscript();
    const sidebar = () => w.findComponent({ name: 'SectionNav' });
    const ed = () => leadEditor(w);
    expect(sidebar().isVisible()).toBe(true);
    ed().vm.$emit('layout', layout(true, 300));
    await settle();
    expect(sidebar().isVisible()).toBe(false);
    expect(w.find('[data-test="tb-navigator"]').attributes('aria-pressed')).toBe('false');
    // Real toggle: the toolbar's review button closes the panel, and the editor reports it.
    await w.find('[data-test="tb-review"]').trigger('click');
    await settle();
    expect(sidebar().isVisible()).toBe(true);
    w.unmount();
  });

  it('keeps the open-book toast centred on the desk, clear of the review panel (#93)', async () => {
    const { w } = await withManuscript();
    const ed = () => leadEditor(w);
    // 1024px window, outline auto-closed: desk 16..688, review panel from 688.
    ed().vm.$emit('layout', { ...layout(true, 672), deskLeft: 16 });
    await settle();
    const style = w.find('[data-test="open-toast"]').attributes('style') ?? '';
    expect(style).toContain('left: 352px');
    expect(style).toContain('max-width: 624px');
    w.unmount();
  });

  it('marks the outline forced only while the writer holds it open with the panel shown (#96)', async () => {
    const { w } = await withManuscript();
    const ed = () => leadEditor(w);
    const desk = () => w.get('[data-test="desk"]');
    ed().vm.$emit('layout', layout(true, 300));
    await settle();
    expect(desk().classes()).not.toContain('desk--outline-forced'); // auto-closed, not forced
    await w.find('[data-test="tb-navigator"]').trigger('click'); // writer forces it open
    await settle();
    expect(ed().props('outlineForced')).toBe(true);
    expect(desk().classes()).toContain('desk--outline-forced');
    ed().vm.$emit('layout', layout(false, 900)); // review closes
    await settle();
    expect(ed().props('outlineForced')).toBe(false);
    w.unmount();
  });

  it('a forced outline stays open and forced across focus mode (#97)', async () => {
    const { w } = await withManuscript();
    const sidebar = () => w.findComponent({ name: 'SectionNav' });
    const ed = () => leadEditor(w);
    ed().vm.$emit('layout', layout(true, 300));
    await settle();
    await w.find('[data-test="tb-navigator"]').trigger('click'); // force it open
    await settle();
    ed().vm.$emit('focus-mode', true);
    ed().vm.$emit('layout', { ...layout(false, 1000), focusMode: true });
    await settle();
    ed().vm.$emit('focus-mode', false);
    ed().vm.$emit('layout', layout(true, 368));
    await settle();
    expect(sidebar().isVisible()).toBe(true);
    expect(ed().props('outlineForced')).toBe(true);
    w.unmount();
  });

  it('the editor marks its focus-mode layout so the App keeps the forced outline (#97)', async () => {
    const { w } = await withManuscript();
    const ed = () => leadEditor(w);
    await w.find('[data-test="focus-mode"]').trigger('click');
    await settle();
    const emitted = (ed().emitted('layout') ?? []) as [{ focusMode?: boolean }][];
    expect(emitted.at(-1)?.[0].focusMode).toBe(true);
    w.unmount();
  });

  it('the forced state does not drop while focus mode is on (#97)', async () => {
    const { w } = await withManuscript();
    const ed = () => leadEditor(w);
    ed().vm.$emit('layout', layout(true, 300));
    await settle();
    await w.find('[data-test="tb-navigator"]').trigger('click');
    ed().vm.$emit('focus-mode', true);
    await settle();
    expect(ed().props('outlineForced')).toBe(true);
    w.unmount();
  });

  it("the writer's own Chapters toggle wins over the auto reopen", async () => {
    const { w } = await withManuscript();
    const sidebar = () => w.findComponent({ name: 'SectionNav' });
    const ed = () => leadEditor(w);
    const chapters = w.find('[data-test="tb-navigator"]');
    ed().vm.$emit('layout', layout(true, 300));
    await settle();
    await chapters.trigger('click'); // reopen by hand
    await chapters.trigger('click'); // and close by hand
    ed().vm.$emit('layout', layout(false, 900));
    await settle();
    expect(sidebar().isVisible()).toBe(false);
    w.unmount();
  });
});

describe('App outline vs margin notes (#98)', () => {
  const L = (deskWidth: number, marginNotes: boolean) => ({
    reviewShown: true,
    deskWidth,
    marginNotes,
    deskLeft: 16,
  });
  const noRoomCopy = 'Not enough room for the outline while notes are showing.';

  it('reopens the auto-closed outline when the notes hide, not when the writer closed it', async () => {
    const { w } = await withManuscript();
    const sidebar = () => w.findComponent({ name: 'SectionNav' });
    const ed = () => leadEditor(w);
    ed().vm.$emit('layout', L(496, false));
    ed().vm.$emit('layout', L(496, true));
    await settle();
    expect(sidebar().isVisible()).toBe(false);
    ed().vm.$emit('layout', L(800, false));
    await settle();
    expect(sidebar().isVisible()).toBe(true);
    // The writer closes it by hand: hiding the notes again must not reopen it.
    ed().vm.$emit('layout', L(496, false));
    await w.find('[data-test="tb-navigator"]').trigger('click');
    await settle();
    ed().vm.$emit('layout', L(800, true));
    ed().vm.$emit('layout', L(800, false));
    await settle();
    expect(sidebar().isVisible()).toBe(false);
    w.unmount();
  });

  it('Chapters with no room shows the polite cue in the toast region; Hide notes opens the outline', async () => {
    const { w } = await withManuscript();
    const sidebar = () => w.findComponent({ name: 'SectionNav' });
    const ed = () => leadEditor(w);
    const chapters = () => w.find('[data-test="tb-navigator"]');
    ed().vm.$emit('layout', L(368, false));
    ed().vm.$emit('layout', L(368, true)); // 1024px: notes appear, outline auto-closes
    ed().vm.$emit('layout', L(672, true));
    await settle();
    expect(sidebar().isVisible()).toBe(false);
    await chapters().trigger('click');
    await settle();
    const regions = w.findAll('[data-test="toast-region"]');
    expect(regions).toHaveLength(1); // the existing region, not a second one
    expect(regions[0]!.attributes('role')).toBe('status');
    expect(regions[0]!.attributes('aria-live')).toBe('polite');
    expect(regions[0]!.text()).toContain(noRoomCopy);
    expect(sidebar().isVisible()).toBe(false);
    expect(chapters().attributes('aria-expanded')).toBe('false');
    expect(w.find('[data-test="open-toast"]').attributes('style')).toContain('left: 352px');
    const action = w.get('[data-test="toast-dismiss"]');
    expect(action.text()).toBe('Hide notes');
    await action.trigger('click');
    await settle();
    expect(ed().props('notesHidden')).toBe(true);
    expect(sidebar().isVisible()).toBe(true);
    expect(chapters().attributes('aria-expanded')).toBe('true');
    expect(w.find('[data-test="toast"]').exists()).toBe(false);
    // The editor reports the new layout (no notes, outline open): it holds.
    ed().vm.$emit('layout', L(368, false));
    await settle();
    expect(sidebar().isVisible()).toBe(true);
    // Closing the review panel brings the notes back for next time.
    ed().vm.$emit('layout', { ...L(990, false), reviewShown: false });
    await settle();
    expect(ed().props('notesHidden')).toBe(false);
    w.unmount();
  });

  it('a layout change closes the cue', async () => {
    const { w } = await withManuscript();
    const ed = () => leadEditor(w);
    ed().vm.$emit('layout', L(368, true));
    ed().vm.$emit('layout', L(672, true));
    await settle();
    await w.find('[data-test="tb-navigator"]').trigger('click');
    await settle();
    expect(w.find('[data-test="toast"]').exists()).toBe(true);
    ed().vm.$emit('layout', L(800, true));
    await settle();
    expect(w.find('[data-test="toast"]').exists()).toBe(false);
    w.unmount();
  });

  it('the cue closes after the usual timeout, and a second click while it shows does not restart it', async () => {
    const { w } = await withManuscript();
    const ed = () => leadEditor(w);
    ed().vm.$emit('layout', L(368, true));
    ed().vm.$emit('layout', L(672, true));
    await settle();
    vi.useFakeTimers();
    try {
      await w.find('[data-test="tb-navigator"]').trigger('click');
      await nextTick();
      vi.advanceTimersByTime(5000);
      await w.find('[data-test="tb-navigator"]').trigger('click');
      await nextTick();
      // A restart would push the dismissal to 13s: it must still close at the original 8s.
      vi.advanceTimersByTime(2999);
      await nextTick();
      expect(w.find('[data-test="toast"]').text()).toContain(noRoomCopy);
      vi.advanceTimersByTime(1);
      await nextTick();
      expect(w.find('[data-test="toast"]').exists()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    w.unmount();
  });

  it('unmounting while the cue shows clears its timer', async () => {
    const { w } = await withManuscript();
    const ed = () => leadEditor(w);
    ed().vm.$emit('layout', L(368, true));
    ed().vm.$emit('layout', L(672, true));
    await settle();
    const set = vi.spyOn(globalThis, 'setTimeout');
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    try {
      await w.find('[data-test="tb-navigator"]').trigger('click');
      await nextTick();
      const call = set.mock.calls.findIndex((c) => c[1] === 8000);
      expect(call).toBeGreaterThanOrEqual(0);
      const id = set.mock.results[call]!.value;
      w.unmount();
      expect(clear.mock.calls.some((c) => c[0] === id)).toBe(true);
    } finally {
      set.mockRestore();
      clear.mockRestore();
    }
  });

  it('Hide notes removes the margin notes and reports marginNotes:false; they return after the panel closes', async () => {
    const { w } = await withManuscript();
    const ed = () => leadEditor(w);
    const st = (ed().vm as unknown as { $: { setupState: { review: unknown[] } } }).$.setupState;
    st.review = [
      { id: 'q1', type: 'insertion', author: 'Bot', text: 'x', from: 1, to: 3, quote: 'ab' },
    ];
    await settle();
    expect(w.find('[data-test="margin-notes"]').exists()).toBe(true);
    expect(ed().emitted('layout')!.at(-1)![0]).toMatchObject({
      reviewShown: true,
      marginNotes: true,
    });
    ed().vm.$emit('layout', L(368, false));
    ed().vm.$emit('layout', L(368, true)); // 1024px: notes appear, outline auto-closes
    ed().vm.$emit('layout', L(672, true));
    await settle();
    await w.find('[data-test="tb-navigator"]').trigger('click');
    await settle();
    await w.get('[data-test="toast-dismiss"]').trigger('click');
    await settle();
    expect(w.find('[data-test="margin-notes"]').exists()).toBe(false);
    const layouts = ed().emitted('layout')!;
    expect((layouts[layouts.length - 1]![0] as { marginNotes: boolean }).marginNotes).toBe(false);
    await w.find('[data-test="tb-review"]').trigger('click'); // close the panel
    await settle();
    await w.find('[data-test="tb-review"]').trigger('click'); // and open it again
    await settle();
    expect(w.find('[data-test="margin-notes"]').exists()).toBe(true);
    w.unmount();
  });
});
