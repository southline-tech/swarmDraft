import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { Editor } from '@tiptap/core';
import { manuscriptEditorOptions } from '@swarmdraft/editor';
import EditorToolbar from './EditorToolbar.vue';
import { THEME_KEY } from '../settings/prefs';

vi.mock('../export/run-book-export', () => ({
  runBookExport: vi.fn(),
}));
vi.mock('../export/api', () => ({
  exportApi: { revealInFolder: vi.fn() },
}));

const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((e) => e.destroy()));

function mountBar() {
  const editor = new Editor({
    ...manuscriptEditorOptions({ content: { type: 'doc', content: [{ type: 'paragraph' }] } }),
    element: document.createElement('div'),
  });
  editors.push(editor);
  return mount(EditorToolbar, {
    attachTo: document.body,
    props: { editor, manuscriptId: 'book-1', draftLabel: 'Harbor Ledger' },
  });
}

describe('Wave 6a toolbar (#245)', () => {
  it('theme control toggles data-theme and persists', async () => {
    localStorage.removeItem(THEME_KEY);
    delete document.documentElement.dataset.theme;
    const w = mountBar();
    expect(document.documentElement.dataset.theme).not.toBe('dark');
    expect(w.get('[data-test="toolbar-theme"]').find('[data-icon="moon"]').exists()).toBe(true);
    await w.get('[data-test="toolbar-theme"]').trigger('click');
    expect(w.get('[data-test="toolbar-theme"]').find('[data-icon="sun"]').exists()).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('dark');
    await w.get('[data-test="toolbar-theme"]').trigger('click');
    expect(document.documentElement.dataset.theme).toBe('light');
    w.unmount();
  });

  it('emits open-settings and open-agents', async () => {
    const w = mountBar();
    await w.get('[data-test="toolbar-settings"]').trigger('click');
    await w.get('[data-test="toolbar-agents"]').trigger('click');
    expect(w.emitted('open-settings')).toHaveLength(1);
    expect(w.emitted('open-agents')).toHaveLength(1);
    w.unmount();
  });

  it('export menu exposes docx, pdf, and markdown items', async () => {
    const w = mountBar();
    await w.get('[data-test="toolbar-export"]').trigger('click');
    expect(w.get('[data-test="export-menu"]').isVisible()).toBe(true);
    for (const id of ['export-docx', 'export-pdf', 'export-md']) {
      expect(w.find(`[data-test="${id}"]`).exists()).toBe(true);
    }
    w.unmount();
  });

  it('PDF is greyed out as coming later without running export (#250)', async () => {
    const { runBookExport } = await import('../export/run-book-export');
    const w = mountBar();
    await w.get('[data-test="toolbar-export"]').trigger('click');
    const pdf = w.get('[data-test="export-pdf"]');
    expect(pdf.attributes('disabled')).toBeDefined();
    expect(pdf.text()).toContain('Coming later');
    expect(runBookExport).not.toHaveBeenCalled();
    w.unmount();
  });
});
