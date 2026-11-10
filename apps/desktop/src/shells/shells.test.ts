import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import * as Y from 'yjs';
import { docToYDoc } from '@swarmdraft/docx';
import { collectReviewItems, listSuggestions } from '@swarmdraft/editor';
import ManuscriptEditor from '../ManuscriptEditor.vue';
import ContextMenu from './ContextMenu.vue';
import type { ContextMenuAction } from './context-menu';
import { SAMPLE_DOC } from '../fixtures/sample';
import {
  loadProfile,
  loadTracking,
  PROFILE_KEY,
  TRACK_PROMPT_SEEN_KEY,
  TRACKING_KEY,
} from '../settings/prefs';
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
    const live = w.find('[data-test="find-count-live"]');
    expect(live.attributes('aria-live')).toBe('polite');
    expect(live.text()).toMatch(/1 of 1/);
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

  it('throttles the match announcement while typing and announces navigation immediately', async () => {
    const { w } = await mounted();
    await w.find('[data-test="tb-find"]').trigger('click');
    vi.useFakeTimers();
    try {
      const input = w.get('[data-test="find-input"]');
      const live = () => w.get('[data-test="find-count-live"]').text().trim();
      const visible = () => w.get('[data-test="find-count"]').text().trim();

      await input.setValue('t');
      await input.setValue('th');
      await input.setValue('the');
      expect(visible()).toMatch(/\d+ of \d+/);
      expect(live()).toBe('');
      await vi.advanceTimersByTimeAsync(349);
      expect(live()).toBe('');
      await vi.advanceTimersByTimeAsync(1);
      expect(live()).toBe(visible());

      await input.setValue('rain');
      expect(visible()).toMatch(/1 of 1/);
      expect(live()).not.toBe(visible());
      await input.trigger('keydown', { key: 'Enter' });
      expect(live()).toBe(visible());

      await input.setValue('the');
      expect(live()).not.toBe(visible());
      await w.get('[data-test="find-next"]').trigger('click');
      expect(live()).toBe(visible());

      await w.get('[data-test="find-prev"]').trigger('click');
      expect(live()).toBe(visible());

      await input.setValue('rain');
      await w.get('[data-test="replace-input"]').setValue('mist');
      const beforeReplace = live();
      await w.get('[data-test="replace-one"]').trigger('click');
      await flushPromises();
      expect(live()).toBe(visible());
      expect(live()).not.toBe(beforeReplace);
    } finally {
      vi.useRealTimers();
      w.unmount();
    }
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
    expect(collectReviewItems(editor.state.doc).some((r) => r.type === 'comment_anchor')).toBe(
      true,
    );

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
    expect(w.find('[data-test="shortcuts-close"] [data-icon="x"]').exists()).toBe(true);
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
    const t = w.find('[data-test="track-changes-toggle"]');
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

  it('toggles track changes with Ctrl+Shift+E and lists it on the sheet', async () => {
    localStorage.removeItem(TRACKING_KEY);
    localStorage.removeItem(TRACK_PROMPT_SEEN_KEY);
    localStorage.removeItem(PROFILE_KEY);
    const { w } = await mounted();
    const toggle = w.get('[data-test="track-changes-toggle"]');
    expect(toggle.attributes('aria-pressed')).toBe('false');
    expect(toggle.attributes('aria-keyshortcuts')).toBe('Control+Shift+E');
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, shiftKey: true, bubbles: true }),
    );
    await flushPromises();
    expect(toggle.attributes('aria-pressed')).toBe('true');
    expect(loadTracking()).toBe(true);

    await w.find('[data-test="shortcuts-open"]').trigger('click');
    const sheet = w.get('[data-test="shortcuts-sheet"]');
    expect(sheet.text()).toContain('Track changes');
    expect(sheet.text()).toContain('Ctrl');
    expect(sheet.text()).toContain('E');
    await sheet.trigger('keydown', { key: 'e', ctrlKey: true, shiftKey: true });
    expect(toggle.attributes('aria-pressed')).toBe('true');
    await sheet.trigger('keydown', { key: 'Escape' });

    await w.find('[data-test="tb-find"]').trigger('click');
    w.get('[data-test="find-input"]').element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, shiftKey: true, bubbles: true }),
    );
    await flushPromises();
    expect(toggle.attributes('aria-pressed')).toBe('true');

    w.unmount();
    localStorage.removeItem(TRACKING_KEY);
    localStorage.removeItem(TRACK_PROMPT_SEEN_KEY);
    localStorage.removeItem(PROFILE_KEY);
  });

  it('toggles track changes once from the lead when another section is mounted', async () => {
    localStorage.removeItem(TRACKING_KEY);
    localStorage.removeItem(TRACK_PROMPT_SEEN_KEY);
    localStorage.removeItem(PROFILE_KEY);
    const lead = mount(ManuscriptEditor, {
      props: { doc: docToYDoc(SAMPLE_DOC as never), computerName: 'Rowan Vale' },
      attachTo: document.body,
    });
    const slice = mount(ManuscriptEditor, {
      props: { doc: docToYDoc(SAMPLE_DOC as never), sliceMode: true },
      attachTo: document.body,
    });
    await flushPromises();
    const toggle = lead.get('[data-test="track-changes-toggle"]');
    expect(toggle.attributes('aria-pressed')).toBe('false');
    expect(slice.find('[data-test="track-changes-toggle"]').exists()).toBe(false);

    const chord = (target: EventTarget, repeat = false) => {
      target.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'e',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          repeat,
        }),
      );
    };

    chord(slice.get('.tiptap').element);
    await flushPromises();
    // Caret in the other section still toggles the lead, once, so the toolbar and the
    // saved preference stay together. A second editor must not flip them back.
    expect(toggle.attributes('aria-pressed')).toBe(String(loadTracking()));
    expect(loadTracking()).toBe(true);
    expect(lead.find('[data-test="name-prompt"]').exists()).toBe(true);
    expect(slice.find('[data-test="name-prompt"]').exists()).toBe(false);

    const sliceEditor = (
      slice.get('.tiptap').element as unknown as { editor: import('@tiptap/core').Editor }
    ).editor;
    sliceEditor.view.dispatch(
      sliceEditor.state.tr.insertText('!', sliceEditor.state.doc.content.size - 1),
    );
    await flushPromises();
    expect(
      listSuggestions(sliceEditor.getJSON() as never).some(
        (item) =>
          item.kind === 'suggestion_insert' && item.text === '!' && item.author === 'Rowan Vale',
      ),
    ).toBe(true);

    chord(slice.get('.tiptap').element, true);
    await flushPromises();
    expect(toggle.attributes('aria-pressed')).toBe('true');
    expect(loadTracking()).toBe(true);
    expect(
      listSuggestions(sliceEditor.getJSON() as never).some(
        (item) => item.kind === 'suggestion_insert' && item.text === '!',
      ),
    ).toBe(true);

    chord(toggle.element);
    await flushPromises();
    expect(toggle.attributes('aria-pressed')).toBe('false');
    expect(loadTracking()).toBe(false);

    chord(toggle.element);
    await flushPromises();
    expect(toggle.attributes('aria-pressed')).toBe('true');
    expect(loadTracking()).toBe(true);
    await lead.get('[data-test="name-prompt-ok"]').trigger('click');

    await slice.setProps({ sliceMode: false });
    await lead.setProps({ sliceMode: true });
    await flushPromises();
    expect(slice.find('[data-test="name-prompt"]').exists()).toBe(false);
    expect(document.querySelectorAll('[data-test="name-prompt"]').length).toBe(0);
    expect(slice.get('[data-test="track-changes-toggle"]').attributes('aria-pressed')).toBe(
      String(loadTracking()),
    );

    lead.unmount();
    slice.unmount();
    localStorage.removeItem(TRACKING_KEY);
    localStorage.removeItem(TRACK_PROMPT_SEEN_KEY);
    localStorage.removeItem(PROFILE_KEY);
  });

  it('uses the saved name for a new slice insert after the lead reloads the profile', async () => {
    localStorage.removeItem(TRACKING_KEY);
    localStorage.removeItem(TRACK_PROMPT_SEEN_KEY);
    localStorage.removeItem(PROFILE_KEY);
    const lead = mount(ManuscriptEditor, {
      props: { doc: docToYDoc(SAMPLE_DOC as never), computerName: 'Rowan Vale' },
      attachTo: document.body,
    });
    const slice = mount(ManuscriptEditor, {
      props: { doc: docToYDoc(SAMPLE_DOC as never), sliceMode: true },
      attachTo: document.body,
    });
    await flushPromises();
    await lead.get('[data-test="track-changes-toggle"]').trigger('click');
    await lead.get('[data-test="name-prompt-change"]').trigger('click');
    await lead.get('[data-test="settings-name"]').setValue('Sample Writer');
    await lead.get('[data-test="settings-save"]').trigger('click');
    await flushPromises();
    expect(loadProfile().name).toBe('Sample Writer');
    await lead.get('[data-test="settings-cancel"]').trigger('click');
    await flushPromises();

    const sliceEditor = (
      slice.get('.tiptap').element as unknown as { editor: import('@tiptap/core').Editor }
    ).editor;
    sliceEditor.view.dispatch(
      sliceEditor.state.tr.insertText('?', sliceEditor.state.doc.content.size - 1),
    );
    await flushPromises();
    expect(
      listSuggestions(sliceEditor.getJSON() as never).some(
        (item) =>
          item.kind === 'suggestion_insert' && item.text === '?' && item.author === 'Sample Writer',
      ),
    ).toBe(true);

    lead.unmount();
    slice.unmount();
    localStorage.removeItem(TRACKING_KEY);
    localStorage.removeItem(TRACK_PROMPT_SEEN_KEY);
    localStorage.removeItem(PROFILE_KEY);
  });

  it('keeps merge with previous visible when it cannot run', async () => {
    const ydoc = docToYDoc(SAMPLE_DOC as never);
    const w = mount(ManuscriptEditor, {
      props: { doc: ydoc, chapterOpsEnabled: true, canMergePrevChapter: false },
      attachTo: document.body,
    });
    await flushPromises();
    await openContextMenu(w);
    const item = w.get('[data-test="ctx-merge_prev_chapter"]');
    expect(item.isVisible()).toBe(true);
    expect(item.attributes('aria-disabled')).toBe('true');
    expect(item.attributes('aria-describedby')).toBe('ctx-reason-merge_prev_chapter');
    expect(item.text()).toContain('Merge with previous chapter');
    expect(item.text()).toContain('No previous chapter');
    await item.trigger('click');
    expect(w.emitted('merge-prev-chapter')).toBeUndefined();
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

  it('keeps Merge with previous chapter in the menu when disabled and exposes the reason', () => {
    const w = mount(ContextMenu, {
      props: {
        x: 8,
        y: 8,
        showChapterGroup: true,
        mergePrevTitle: 'Read-only',
        disabled: new Set<ContextMenuAction>(['merge_prev_chapter']),
      },
      attachTo: document.body,
    });
    const item = w.get('[data-test="ctx-merge_prev_chapter"]');
    expect(item.isVisible()).toBe(true);
    expect(item.attributes('aria-disabled')).toBe('true');
    expect(item.attributes('aria-describedby')).toBe('ctx-reason-merge_prev_chapter');
    expect(item.text()).toContain('Merge with previous chapter');
    expect(w.get('#ctx-reason-merge_prev_chapter').text()).toBe('Read-only');
    w.unmount();
  });
});
