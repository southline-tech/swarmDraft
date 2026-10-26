import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import * as Y from 'yjs';
import { docToYDoc, importDocx, readStructure, writeStructure, yDocToDoc } from '@coauthor/docx';
import App from './App.vue';
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

describe('App', () => {
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
  dismissRecoveryNotices: vi.fn(async () => {}),
  restoreBackup: vi.fn(async () => ({
    tokensRevoked: 2,
    manifest: {},
    preRestoreSnapshot: '/tmp/x/backups/p.zip',
  })),
}));

describe('restore confirmation', () => {
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
