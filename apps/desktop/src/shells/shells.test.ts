import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import * as Y from 'yjs';
import { docToYDoc } from '@swarmdraft/docx';
import { listSuggestions } from '@swarmdraft/editor';
import ManuscriptEditor from '../ManuscriptEditor.vue';
import ContextMenu from './ContextMenu.vue';
import type { ContextMenuAction } from './context-menu';
import { SAMPLE_DOC } from '../fixtures/sample';
import { loadTracking, PROFILE_KEY, TRACK_PROMPT_SEEN_KEY, TRACKING_KEY } from '../settings/prefs';
import { REVIEW_SHORTCUTS } from '../review/review-state';
import { SHORTCUTS } from '../toolbar/toolbar';
import { MANUSCRIPT_SHORTCUTS } from './app-shortcuts';

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

describe('Find & replace (#53)', () => {
  it('match count, navigation, replace, options, shortcuts, and themes', async () => {
    const { w, editor } = await mounted();
    await w.find('.manuscript-editor').trigger('keydown', { key: 'f', ctrlKey: true });
    expect(w.find('[data-test="find-panel"]').exists()).toBe(true);

    await w.find('[data-test="find-input"]').setValue('rain');
    await flushPromises();
    expect(w.find('[data-test="find-count"]').text()).toMatch(/1 of 1/);
    expect(w.find('.find-match').exists()).toBe(true);
    expect(document.activeElement?.getAttribute('data-test')).toBe('find-input');
    expect(editor.view.hasFocus()).toBe(false);

    expect(w.find('[data-test="find-prev"] [data-icon="chevron-up"]').exists()).toBe(true);
    expect(w.find('[data-test="find-next"] [data-icon="chevron-down"]').exists()).toBe(true);
    expect(w.find('[data-test="find-close"] [data-icon="x"]').exists()).toBe(true);

    await w.find('[data-test="find-next"]').trigger('click');
    expect(editor.view.hasFocus()).toBe(false);
    await w.find('[data-test="find-prev"]').trigger('click');
    expect(editor.view.hasFocus()).toBe(false);

    await w.find('[data-test="replace-input"]').setValue('mist');
    await w.find('[data-test="replace-one"]').trigger('click');
    await flushPromises();
    expect(editor.getText()).toContain('mist');
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getText()).toContain('rain');

    await w.find('[data-test="find-input"]').setValue('the');
    await w.find('[data-test="replace-input"]').setValue('a');
    await w.find('[data-test="replace-all"]').trigger('click');
    await flushPromises();
    const afterAll = editor.getText();
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getText()).not.toBe(afterAll);

    await w.find('[data-test="find-match-case"]').trigger('click');
    expect(w.find('[data-test="find-match-case"]').attributes('aria-pressed')).toBe('true');
    await w.find('[data-test="find-whole-word"]').trigger('click');
    expect(w.find('[data-test="find-whole-word"]').attributes('aria-pressed')).toBe('true');

    await w.find('[data-test="find-close"]').trigger('click');
    expect(w.find('[data-test="find-panel"]').exists()).toBe(false);

    await w.find('.manuscript-editor').trigger('keydown', { key: 'h', ctrlKey: true });
    expect(w.find('[data-test="find-panel"]').exists()).toBe(true);
    expect(document.activeElement?.getAttribute('data-test')).toBe('replace-input');

    await w.find('[data-test="find-panel"]').trigger('keydown', { key: 'Escape' });
    expect(w.find('[data-test="find-panel"]').exists()).toBe(false);

    for (const theme of ['light', 'dark'] as const) {
      document.documentElement.dataset.theme = theme;
      await w.find('[data-test="tb-find"]').trigger('click');
      expect(w.get('.sh-find').classes()).toContain('sh-find');
      await w.find('[data-test="find-close"]').trigger('click');
    }

    w.unmount();
  });

  it('does not replace text inside suggestions', async () => {
    const { w, editor } = await mounted();
    const before = editor.getText();
    await w.find('[data-test="tb-find"]').trigger('click');
    await w.find('[data-test="find-input"]').setValue('guttered');
    await flushPromises();
    expect(w.find('[data-test="find-count"]').text()).toBe('No matches');
    await w.find('[data-test="replace-all"]').trigger('click');
    expect(editor.getText()).toBe(before);
    w.unmount();
  });

  it('opens from the toolbar and counts matches', async () => {
    const { w } = await mounted();
    await w.find('[data-test="tb-find"]').trigger('click');
    expect(w.find('[data-test="find-panel"]').exists()).toBe(true);
    await w.find('[data-test="find-input"]').setValue('the');
    expect(w.find('[data-test="find-count"]').text()).toMatch(/of \d+|No matches/);
    await w.find('[data-test="find-close"]').trigger('click');
    w.unmount();
  });
});

describe('UI shells (Part of #36)', () => {
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
    expect(w.find('[data-test="comment-row"]').exists()).toBe(true);

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

  it('opens from the menu button with shared shortcut chord', async () => {
    const { w, unchanged } = await mounted();
    await w.find('[data-test="shortcuts-open"]').trigger('click');
    expect(w.find('[data-test="shortcuts-sheet"]').exists()).toBe(true);
    unchanged();
    w.unmount();
  });

  it('keyboard shortcuts sheet opens with Ctrl+/ and closes on Esc', async () => {
    const { w, unchanged } = await mounted();
    await w.find('.manuscript-editor').trigger('keydown', { key: '/', ctrlKey: true });
    const sheet = w.find('[data-test="shortcuts-sheet"]');
    expect(sheet.exists()).toBe(true);
    expect(sheet.text()).toContain('Keyboard shortcuts');
    expect(sheet.text()).toContain('Bold');
    expect(sheet.text()).toContain(SHORTCUTS.bold.split('+')[1]);
    expect(sheet.text()).toContain(MANUSCRIPT_SHORTCUTS.find.split('+')[1]);
    expect(sheet.text()).toContain(REVIEW_SHORTCUTS.accept.split('+').slice(-1)[0]!);
    expect(document.activeElement?.getAttribute('data-test')).toBe('shortcuts-close');
    await sheet.trigger('keydown', { key: 'Escape' });
    expect(w.find('[data-test="shortcuts-sheet"]').exists()).toBe(false);
    unchanged();
    w.unmount();
  });

  it('does not run editor shortcuts while the shortcuts sheet is open', async () => {
    const { w } = await mounted();
    await w.find('[data-test="shortcuts-open"]').trigger('click');
    await w.find('[data-test="shortcuts-sheet"]').trigger('keydown', {
      key: 'f',
      ctrlKey: true,
    });
    expect(w.find('[data-test="find-panel"]').exists()).toBe(false);
    w.unmount();
  });

  it('applies heading style from Ctrl+Alt+1 on the editor shell (#56)', async () => {
    const ydoc = docToYDoc(SAMPLE_DOC as never);
    const w = mount(ManuscriptEditor, { props: { doc: ydoc }, attachTo: document.body });
    await flushPromises();
    const editor = (
      w.find('.tiptap').element as unknown as { editor: import('@tiptap/core').Editor }
    ).editor;
    editor.commands.setTextSelection(1);
    await w
      .find('.manuscript-editor')
      .trigger('keydown', { key: '1', ctrlKey: true, altKey: true });
    expect(editor.isActive('heading')).toBe(true);
    w.unmount();
  });

  it('track changes toggle persists, prompts once, and records edits (#57, #126)', async () => {
    localStorage.removeItem(TRACKING_KEY);
    localStorage.removeItem(TRACK_PROMPT_SEEN_KEY);
    localStorage.removeItem(PROFILE_KEY);
    const { w, editor, unchanged } = await mounted();
    const t = w.find('[data-test="track-changes"]');
    expect(t.attributes('aria-pressed')).toBe('false');
    await t.trigger('click');
    expect(t.attributes('aria-pressed')).toBe('true');
    expect(t.text()).toContain('Track changes · On');
    expect(w.find('[data-test="status-track-changes"]').text()).toBe('Track changes: On');
    expect(w.find('[data-test="name-prompt"]').exists()).toBe(true);
    expect(w.findAll('[data-test="margin-note"]').length).toBeGreaterThan(0);
    unchanged();
    await w.get('[data-test="name-prompt-ok"]').trigger('click');
    expect(w.find('[data-test="name-prompt"]').exists()).toBe(false);
    expect(loadTracking()).toBe(true);
    editor.view.dispatch(editor.state.tr.insertText('!', editor.state.doc.content.size - 1));
    await flushPromises();
    expect(listSuggestions(editor.getJSON() as never).length).toBeGreaterThan(
      listSuggestions(SAMPLE_DOC as never).length,
    );
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

  it('opens paragraph styles with ArrowRight and activates with Enter', async () => {
    const w = mount(ContextMenu, {
      props: { x: 8, y: 8, disabled: new Set<ContextMenuAction>() },
      attachTo: document.body,
    });
    const menu = w.get('[data-test="context-menu"]');
    await menu.trigger('keydown', { key: 'ArrowDown' });
    await menu.trigger('keydown', { key: 'ArrowDown' });
    await menu.trigger('keydown', { key: 'ArrowDown' });
    await menu.trigger('keydown', { key: 'ArrowDown' });
    expect(document.activeElement?.getAttribute('data-test')).toBe('ctx-style');
    await menu.trigger('keydown', { key: 'ArrowRight' });
    await flushPromises();
    expect(w.find('[data-test="ctx-style-heading"]').exists()).toBe(true);
    expect(document.activeElement?.getAttribute('data-test')).toBe('ctx-style-body');
    await menu.trigger('keydown', { key: 'ArrowDown' });
    expect(document.activeElement?.getAttribute('data-test')).toBe('ctx-style-heading');
    await menu.trigger('keydown', { key: 'Enter' });
    expect(w.emitted('select')).toEqual([['heading']]);
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
