import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import * as Y from 'yjs';
import { docToYDoc } from '@coauthor/docx';
import ManuscriptEditor from '../ManuscriptEditor.vue';
import ContextMenu from './ContextMenu.vue';
import type { ContextMenuAction } from './context-menu';
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

async function openContextMenu(w: ReturnType<typeof mount>) {
  await w.find('.page').trigger('contextmenu', { clientX: 100, clientY: 100 });
  await flushPromises();
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

  it('context menu closes on Esc and click-away without changing the doc', async () => {
    const { w, unchanged } = await mounted();
    await openContextMenu(w);
    await w.get('[data-test="context-dismiss"]').trigger('click');
    expect(w.find('[data-test="context-menu"]').exists()).toBe(false);
    unchanged();
    await openContextMenu(w);
    await w.get('[data-test="context-menu"]').trigger('keydown', { key: 'Escape' });
    expect(w.find('[data-test="context-menu"]').exists()).toBe(false);
    unchanged();
    w.unmount();
  });

  it('context menu cut, copy, paste, style, and comment change the manuscript (#54)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const readText = vi.fn().mockResolvedValue(' CLIP');
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText, readText },
      configurable: true,
    });

    const { w, editor } = await mounted();
    const select = (snippet: string) => {
      let from = -1;
      let to = -1;
      editor.state.doc.descendants((node, pos) => {
        if (!node.isText || from >= 0) return;
        const i = node.text!.indexOf(snippet);
        if (i >= 0) {
          from = pos + i;
          to = from + snippet.length;
        }
      });
      editor.commands.setTextSelection({ from, to });
    };

    select('rain');
    await openContextMenu(w);
    await w.find('[data-test="ctx-copy"]').trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith('rain');

    await openContextMenu(w);
    await w.find('[data-test="ctx-cut"]').trigger('click');
    await flushPromises();
    expect(editor.getText()).not.toContain('rain');

    editor.commands.setTextSelection(1);
    await openContextMenu(w);
    await w.find('[data-test="ctx-paste"]').trigger('click');
    await flushPromises();
    expect(editor.getText()).toContain('CLIP');

    await openContextMenu(w);
    await w.find('[data-test="ctx-style"]').trigger('click');
    await w.find('[data-test="ctx-style-heading"]').trigger('click');
    await flushPromises();
    expect(editor.isActive('heading')).toBe(true);

    select('Morning');
    await openContextMenu(w);
    await w.find('[data-test="ctx-comment"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="review-item"]').exists()).toBe(true);

    await openContextMenu(w);
    await w.find('[data-test="ctx-ask-bot"]').trigger('click');
    expect(w.emitted('ask-bot')).toHaveLength(1);

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

  it('track changes toggle is visual state only', async () => {
    const { w, unchanged } = await mounted();
    const t = w.find('[data-test="track-changes"]');
    expect(t.attributes('aria-pressed')).toBe('false');
    await t.trigger('click');
    expect(t.attributes('aria-pressed')).toBe('true');
    expect(t.text()).toContain('On');
    expect(w.find('[data-test="status-tracking"]').exists()).toBe(true);
    // The read-only Open/Resolved tabs were superseded by the real review panel (#44).
    expect(w.findAll('[data-test="margin-note"]').length).toBeGreaterThan(0);
    unchanged();
    w.unmount();
  });
});

describe('ContextMenu theme (#54)', () => {
  it('uses token-backed shell classes in light and dark', () => {
    for (const theme of ['light', 'dark'] as const) {
      document.documentElement.dataset.theme = theme;
      const w = mount(ContextMenu, {
        props: { x: 8, y: 8, disabled: new Set<ContextMenuAction>() },
        attachTo: document.body,
      });
      expect(w.get('.sh-menu').classes()).toContain('sh-menu');
      w.unmount();
    }
  });

  it('shows a check on the active paragraph style and sparkle on ask-bot', async () => {
    const w = mount(ContextMenu, {
      props: { x: 8, y: 8, activeStyle: 'heading', disabled: new Set<ContextMenuAction>() },
      attachTo: document.body,
    });
    await w.find('[data-test="ctx-style"]').trigger('click');
    const heading = w.get('[data-test="ctx-style-heading"]');
    expect(heading.attributes('aria-checked')).toBe('true');
    expect(heading.find('[data-icon="check"]').exists()).toBe(true);
    expect(w.get('[data-test="ctx-ask-bot"]').find('[data-icon="sparkle"]').exists()).toBe(true);
    w.unmount();
  });

  it('marks disabled entries with aria-disabled', () => {
    const w = mount(ContextMenu, {
      props: { x: 8, y: 8, disabled: new Set<ContextMenuAction>(['cut']) },
      attachTo: document.body,
    });
    expect(w.get('[data-test="ctx-cut"]').attributes('aria-disabled')).toBe('true');
    expect(w.get('[data-test="ctx-copy"]').attributes('aria-disabled')).toBeUndefined();
    w.unmount();
  });
});
