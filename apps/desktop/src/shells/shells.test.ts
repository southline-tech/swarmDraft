import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import * as Y from 'yjs';
import { docToYDoc } from '@coauthor/docx';
import ManuscriptEditor from '../ManuscriptEditor.vue';
import { SAMPLE_DOC } from '../fixtures/sample';

/** Each UI shell opens and renders, and using it leaves the manuscript and its Y.Doc untouched. */
async function mounted() {
  const ydoc = docToYDoc(SAMPLE_DOC as never);
  const w = mount(ManuscriptEditor, { props: { doc: ydoc }, attachTo: document.body });
  await flushPromises();
  const editor = (w.find('.tiptap').element as unknown as { editor: import('@tiptap/core').Editor })
    .editor;
  const before = { doc: editor.state.doc, sv: Y.encodeStateVector(ydoc) };
  const unchanged = () => {
    expect(editor.state.doc.eq(before.doc)).toBe(true);
    expect(Y.encodeStateVector(ydoc)).toEqual(before.sv);
    expect(w.emitted('change')).toBeUndefined();
  };
  return { w, editor, unchanged };
}

describe('UI shells (Part of #36)', () => {
  it('find & replace opens from the toolbar, counts matches, and replace is a no-op', async () => {
    const { w, unchanged } = await mounted();
    await w.find('[data-test="tb-find"]').trigger('click');
    expect(w.find('[data-test="find-panel"]').exists()).toBe(true);
    await w.find('[data-test="find-input"]').setValue('the');
    expect(w.find('[data-test="find-count"]').text()).toMatch(/of \d+|No matches/);
    await w.find('[data-test="replace-input"]').setValue('Synthetic');
    await w.find('[data-test="replace-one"]').trigger('click');
    await w.find('[data-test="replace-all"]').trigger('click');
    await flushPromises();
    unchanged();
    await w.find('[data-test="find-close"]').trigger('click');
    expect(w.find('[data-test="find-panel"]').exists()).toBe(false);
    w.unmount();
  });

  it('context menu opens on right-click and every item is a no-op', async () => {
    const { w, unchanged } = await mounted();
    const ids = ['cut', 'copy', 'paste', 'comment', 'ask-bot'];
    for (const id of ids) {
      await w.find('.page').trigger('contextmenu', { clientX: 100, clientY: 100 });
      expect(w.find('[data-test="context-menu"]').exists()).toBe(true);
      await w.find(`[data-test="ctx-${id}"]`).trigger('click');
      expect(w.find('[data-test="context-menu"]').exists()).toBe(false);
    }
    await w.find('.page').trigger('contextmenu', { clientX: 100, clientY: 100 });
    await w.find('[data-test="ctx-style"]').trigger('click');
    await w.find('[data-test="ctx-style-heading"]').trigger('click');
    await flushPromises();
    unchanged();
    w.unmount();
  });

  it('focus mode hides the chrome and Esc exits', async () => {
    const { w, unchanged } = await mounted();
    await w.find('[data-test="focus-mode"]').trigger('click');
    expect(w.emitted('focus-mode')?.at(-1)).toEqual([true]);
    expect(w.find('[data-test="focus-pill"]').exists()).toBe(true);
    expect(w.find('[data-test="status-bar"]').exists()).toBe(false);
    expect(w.find('[data-test="review"]').exists()).toBe(false);
    await w.find('.manuscript-editor').trigger('keydown', { key: 'Escape' });
    expect(w.emitted('focus-mode')?.at(-1)).toEqual([false]);
    expect(w.find('[data-test="status-bar"]').exists()).toBe(true);
    unchanged();
    w.unmount();
  });

  it('keyboard shortcuts sheet opens with Ctrl+/ and closes on Esc', async () => {
    const { w, unchanged } = await mounted();
    await w.find('.manuscript-editor').trigger('keydown', { key: '/', ctrlKey: true });
    const sheet = w.find('[data-test="shortcuts-sheet"]');
    expect(sheet.exists()).toBe(true);
    expect(sheet.text()).toContain('Keyboard shortcuts');
    expect(document.activeElement?.getAttribute('data-test')).toBe('shortcuts-close');
    await sheet.trigger('keydown', { key: 'Escape' });
    expect(w.find('[data-test="shortcuts-sheet"]').exists()).toBe(false);
    unchanged();
    w.unmount();
  });

  it('track changes toggle and review tabs are visual state only', async () => {
    const { w, unchanged } = await mounted();
    const t = w.find('[data-test="track-changes"]');
    expect(t.attributes('aria-pressed')).toBe('false');
    await t.trigger('click');
    expect(t.attributes('aria-pressed')).toBe('true');
    expect(t.text()).toContain('On');
    expect(w.find('[data-test="status-tracking"]').exists()).toBe(true);
    await w.find('[data-test="review-tab-resolved"]').trigger('click');
    expect(w.find('[data-test="review-resolved-empty"]').exists()).toBe(true);
    expect(w.findAll('[data-test="review-item"]')).toHaveLength(0);
    await w.find('[data-test="review-tab-open"]').trigger('click');
    expect(w.findAll('[data-test="review-item"]').length).toBeGreaterThan(0);
    expect(w.findAll('[data-test="margin-note"]').length).toBeGreaterThan(0);
    unchanged();
    w.unmount();
  });
});
