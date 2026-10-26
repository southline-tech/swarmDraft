import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import * as Y from 'yjs';
import { docToYDoc, importDocx, readStructure, writeStructure, yDocToDoc } from '@coauthor/docx';
import App from './App.vue';
import { storedFixture } from './stored-fixture.test-helper';
import { openSession, sessionFromDocx } from './manuscript-session';

const fixture = resolve(
  __dirname,
  '../../../fixtures/manuscripts/docx-import/mock-manuscript.docx',
);
const bytes = () => new Uint8Array(readFileSync(fixture));
const settle = async () => {
  await flushPromises();
  await flushPromises();
};

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
    expect(w.find('.ProseMirror').attributes('contenteditable')).toBe('true');
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
    const editor = (
      first.find('.tiptap').element as unknown as { editor: import('@tiptap/core').Editor }
    ).editor;
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
    expect(w.find('.ProseMirror').text()).toContain('TYPED ');
    w.unmount();
    vi.mocked(backend.saveSectionUpdate).mockReset();
  });

  it('shows an error and does not open the import when saving fails', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.persistImport).mockRejectedValueOnce('database is locked');
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await chooseFile(w);
    expect(w.text()).toContain('Could not import synthetic.docx: database is locked');
    expect(w.findAll('.row')).toHaveLength(0);
    w.unmount();
  });

  it('renders in browser mode without the desktop backend, with no sample outline', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.getAppInfo).mockResolvedValueOnce(null);
    const w = mount(App);
    await flushPromises();
    expect(w.text()).toContain('coAuthor');
    expect(w.find('[data-test="browser-mode"]').exists()).toBe(true);
    expect(w.find('[data-test="no-manuscript"]').exists()).toBe(true);
    expect(w.findAll('.row')).toHaveLength(0);
  });

  it('shows the imported parts, chapters and scenes in the sidebar', async () => {
    const { w, titles } = await withManuscript();
    const expected = importDocx(bytes(), { manuscriptId: 'm1' }).sections.map((s) => s.title);
    expect(titles()).toEqual(expected);
    expect(titles()).toContain('Part Two: Salt and Lamplight');
    expect(titles()).toContain('Chapter 4: The Ledger');
    expect(w.find('.ProseMirror').exists()).toBe(true);
    w.unmount();
  });

  it('persists rename and reorder to the Yjs structure', async () => {
    const { w, session, titles } = await withManuscript();
    const first = readStructure(session.manuscript).find((s) => s.kind === 'chapter')!;
    await w.find(`[data-test="section-${first.id}"]`).trigger('click');
    await w.find('[data-test="rename"]').trigger('click');
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
    await w.find('[data-test="move-up"]').trigger('click');
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

  it('adds a part before the back matter of the imported book', async () => {
    const { w, session } = await withManuscript();
    await w.find('[data-test="add-part"]').trigger('click');
    await settle();
    const kinds = readStructure(session.manuscript).map((s) => s.kind);
    const newPart = kinds.lastIndexOf('part');
    expect(kinds.indexOf('back_matter')).toBeGreaterThan(newPart);
    w.unmount();
  });

  it('places + Part before the back matter and + Front matter after the front matter', async () => {
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
    expect(w.find('.tiptap').text()).toContain('second copy text');
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
    expect(w.text()).toContain('Could not import broken.docx');
    expect(w.findAll('.row')).toHaveLength(rows);
    w.unmount();
  });
});

describe('App saves typing to the section Y.Doc', () => {
  const editorOf = (w: ReturnType<typeof mount>) =>
    (w.find('.tiptap').element as unknown as { editor: import('@tiptap/core').Editor }).editor;
  const chaptersOf = (session: ReturnType<typeof sessionFromDocx>) =>
    session.outline.value.filter((s) => s.kind === 'chapter');

  it('keeps typed text after Reload', async () => {
    const { w, session } = await withManuscript();
    editorOf(w).commands.insertContentAt(1, 'TYPEDONE ');
    await settle();
    const docId = chaptersOf(session)[0]!.docId;
    expect(JSON.stringify(yDocToDoc(session.sections.get(docId)!))).toContain('TYPEDONE');
    w.findComponent({ name: 'ManuscriptEditor' }).vm.$emit('reload');
    await settle();
    expect(w.find('.tiptap').text()).toContain('TYPEDONE');
    w.unmount();
  });

  it('keeps typed text after switching to another section and back', async () => {
    const { w, session } = await withManuscript();
    const [first, second] = chaptersOf(session);
    editorOf(w).commands.insertContentAt(1, 'TYPEDTWO ');
    await settle();
    await w.find(`[data-test="section-${second!.id}"]`).trigger('click');
    await settle();
    expect(w.find('.tiptap').text()).not.toContain('TYPEDTWO');
    await w.find(`[data-test="section-${first!.id}"]`).trigger('click');
    await settle();
    expect(w.find('.tiptap').text()).toContain('TYPEDTWO');
    w.unmount();
  });
});

vi.mock('./backend', async (orig) => ({
  ...(await orig<typeof import('./backend')>()),
  agentsApi: { list: vi.fn(async () => []), tokens: vi.fn(async () => []) },
  getAppInfo: vi.fn(async () => ({ version: '0.1.0', dataDir: '/tmp/x', schemaVersion: 1 })),
  createBackup: vi.fn(async () => '/tmp/x/backups/b.zip'),
  pickBackupToRestore: vi.fn(async () => 'D:\\Backups\\picked.zip'),
  pickBackupDestination: vi.fn(async () => 'D:\\Backups\\new.zip'),
  getRecoveryNotices: vi.fn(async () => []),
  persistImport: vi.fn(async () => storedFixture()),
  deleteManuscript: vi.fn(async () => {}),
  openLatestManuscript: vi.fn(async () => null),
  saveSectionUpdate: vi.fn(async () => {}),
  dismissRecoveryNotices: vi.fn(async () => {}),
  restoreBackup: vi.fn(async () => ({
    tokensRevoked: 2,
    manifest: {},
    preRestoreSnapshot: '/tmp/x/backups/p.zip',
  })),
}));

describe('restore confirmation', () => {
  it('saves pending edits before the restore snapshot, then drops the stale session', async () => {
    const backend = await import('./backend');
    const order: string[] = [];
    vi.mocked(backend.saveSectionUpdate).mockImplementation(async () => void order.push('save'));
    vi.mocked(backend.restoreBackup).mockImplementationOnce(async () => {
      order.push('restore');
      return { tokensRevoked: 0, manifest: {} as never, preRestoreSnapshot: '/tmp/x/p.zip' };
    });
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    await chooseFile(w);
    const editor = await vi.waitFor(() => {
      const e = (
        w.find('.tiptap').element as unknown as { editor?: import('@tiptap/core').Editor } | null
      )?.editor;
      if (!e) throw new Error('editor not mounted yet');
      return e;
    });
    editor.commands.insertContentAt(1, 'PENDING ');
    await w.find('[data-test="restore-path"]').setValue('C:\\b.zip');
    await w.find('[data-test="restore-button"]').trigger('click');
    await w.find('[data-test="restore-confirm-yes"]').trigger('click');
    await flushPromises();
    expect(order).toEqual(['save', 'restore']);
    expect(w.find('.tiptap').exists()).toBe(false);
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
        w.find('.tiptap').element as unknown as { editor?: import('@tiptap/core').Editor } | null
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
        w.find('.tiptap').element as unknown as { editor?: import('@tiptap/core').Editor } | null
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

  it('rolls the import back if opening it fails after the write, and reopens the original', async () => {
    const backend = await import('./backend');
    const original = storedFixture();
    vi.mocked(backend.openLatestManuscript).mockResolvedValue(original);
    const w = mount(App, { attachTo: document.body });
    await settle();
    const bad = storedFixture();
    bad.manuscript.id = 'db-bad';
    bad.sections[0]!.state = [255, 255, 255];
    vi.mocked(backend.persistImport).mockResolvedValueOnce(bad);
    vi.mocked(backend.deleteManuscript).mockClear();
    await chooseFile(w);
    expect(backend.deleteManuscript).toHaveBeenCalledWith('db-bad');
    expect(w.text()).toContain('Could not import synthetic.docx');
    expect(w.find('.tiptap').exists()).toBe(true); // the original, reopened from the database
    w.unmount();
    vi.mocked(backend.openLatestManuscript).mockReset().mockResolvedValue(null);
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
        w.find('.tiptap').element as unknown as { editor?: import('@tiptap/core').Editor } | null
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
    expect(w.find('.tiptap').text()).toContain('UNSAVED ');
    // Saves recover: the retry clears the banner, and now the import goes through.
    vi.mocked(backend.saveSectionUpdate).mockReset();
    vi.mocked(backend.saveSectionUpdate).mockResolvedValue(undefined);
    await new Promise((r) => setTimeout(r, 1100));
    await flushPromises();
    expect(w.find('[data-test="save-error"]').exists()).toBe(false);
    await chooseFile(w);
    expect(backend.persistImport).toHaveBeenCalledTimes(1);
    expect(w.find('[data-test="open-error"]').exists()).toBe(false);
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
        w.find('.tiptap').element as unknown as { editor?: import('@tiptap/core').Editor } | null
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
        w.find('.tiptap').element as unknown as { editor?: import('@tiptap/core').Editor } | null
      )?.editor;
      if (!e) throw new Error('editor not mounted yet');
      return e;
    });
    editor.commands.insertContentAt(1, 'UNSAVED ');
    await w.find('[data-test="restore-path"]').setValue('C:\\b.zip');
    await w.find('[data-test="restore-button"]').trigger('click');
    await w.find('[data-test="restore-confirm-yes"]').trigger('click');
    await flushPromises();
    expect(backend.restoreBackup).not.toHaveBeenCalled();
    expect(w.text()).toContain('Restore cancelled');
    expect(w.text()).toContain("aren't saved yet");
    expect(w.find('[data-test="save-error"]').text()).toContain('Not saved, retrying');
    expect(w.find('.tiptap').exists()).toBe(true); // the session (and its edits) stays open
    vi.mocked(backend.saveSectionUpdate).mockReset();
    vi.mocked(backend.saveSectionUpdate).mockResolvedValue(undefined);
    w.unmount();
    await flushPromises();
  });

  it('does not restore until the user confirms', async () => {
    const backend = await import('./backend');
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.find('[data-test="restore-path"]').setValue('C:\\Users\\a\\b.zip');
    await wrapper.find('[data-test="restore-button"]').trigger('click');
    expect(backend.restoreBackup).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="restore-confirm"]').exists()).toBe(true);
    await wrapper.find('[data-test="restore-confirm-no"]').trigger('click');
    expect(wrapper.find('[data-test="restore-confirm"]').exists()).toBe(false);
    await wrapper.find('[data-test="restore-button"]').trigger('click');
    await wrapper.find('[data-test="restore-confirm-yes"]').trigger('click');
    await flushPromises();
    expect(backend.restoreBackup).toHaveBeenCalledWith('C:\\Users\\a\\b.zip');
    expect(wrapper.find('[data-test="backup-status"]').text()).toContain('p.zip');
    const notice = wrapper.find('[data-test="tokens-revoked-notice"]');
    expect(notice.text()).toContain('revoked all 2 agent token');
    await wrapper.find('[data-test="tokens-notice-dismiss"]').trigger('click');
    expect(wrapper.find('[data-test="tokens-revoked-notice"]').exists()).toBe(false);
  });
});

describe('tokens-revoked notice', () => {
  async function restoreOnce(wrapper: ReturnType<typeof mount>): Promise<void> {
    await wrapper.find('[data-test="restore-path"]').setValue('C:\\b.zip');
    await wrapper.find('[data-test="restore-button"]').trigger('click');
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
    expect(notice.attributes('role')).toBe('status');
    expect(notice.text()).toContain('revoked all 2 agent token');
    expect(notice.text()).toContain('agents are kept');
    await wrapper.find('[data-test="tokens-notice-dismiss"]').trigger('click');
    expect(wrapper.find('[data-test="tokens-revoked-notice"]').exists()).toBe(false);
    await flushPromises();
    expect(wrapper.find('[data-test="tokens-revoked-notice"]').exists()).toBe(false);
  });

  it('is not shown when no tokens were revoked', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.restoreBackup).mockResolvedValueOnce({
      tokensRevoked: 0,
      manifest: {} as never,
      preRestoreSnapshot: '/tmp/x/backups/p.zip',
    });
    const wrapper = mount(App);
    await flushPromises();
    await restoreOnce(wrapper);
    expect(wrapper.find('[data-test="backup-status"]').text()).toContain('Restored');
    expect(wrapper.find('[data-test="tokens-revoked-notice"]').exists()).toBe(false);
  });
});

describe('backup dialogs', () => {
  it('picker selects a file and still requires confirmation', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.restoreBackup).mockClear();
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.find('[data-test="restore-pick"]').trigger('click');
    await flushPromises();
    expect(backend.restoreBackup).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="restore-target"]').text()).toBe('D:\\Backups\\picked.zip');
    await wrapper.find('[data-test="restore-confirm-yes"]').trigger('click');
    await flushPromises();
    expect(backend.restoreBackup).toHaveBeenCalledWith('D:\\Backups\\picked.zip');
  });

  it('backup uses the save-as destination', async () => {
    const backend = await import('./backend');
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.find('[data-test="backup-button"]').trigger('click');
    await flushPromises();
    expect(backend.createBackup).toHaveBeenCalledWith('D:\\Backups\\new.zip', true);
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
    expect(wrapper.find('[data-test="recovery-notice-save-error"]').text()).toContain('disk full');
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

describe('restore closes the open manuscript', () => {
  async function restore(w: ReturnType<typeof mount>) {
    await w.find('[data-test="restore-path"]').setValue('C:\\b.zip');
    await w.find('[data-test="restore-button"]').trigger('click');
    await w.find('[data-test="restore-confirm-yes"]').trigger('click');
    await settle();
  }

  it('drops the pre-restore session and editor, and ignores later edits to the old docs', async () => {
    const { w, session } = await withManuscript();
    expect(w.find('.tiptap').exists()).toBe(true);
    const before = session.outline.value;
    await restore(w);
    expect(w.find('[data-test="no-manuscript"]').exists()).toBe(true);
    expect(w.find('.tiptap').exists()).toBe(false);
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
    expect(w.find('.tiptap').exists()).toBe(false);
    w.unmount();
  });

  it('keeps the session when the restore fails', async () => {
    const backend = await import('./backend');
    vi.mocked(backend.restoreBackup).mockRejectedValueOnce(new Error('bad zip'));
    const { w } = await withManuscript();
    await restore(w);
    expect(w.find('[data-test="backup-status"]').text()).toContain('Restore failed');
    expect(w.find('[data-test="no-manuscript"]').exists()).toBe(false);
    expect(w.find('.tiptap').exists()).toBe(true);
    w.unmount();
  });
});
