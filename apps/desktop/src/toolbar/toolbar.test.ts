import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { Editor, type JSONContent } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { docToYDoc } from '@swarmdraft/docx';
import { collaborativeEditorOptions, manuscriptEditorOptions } from '@swarmdraft/editor';
import EditorToolbar from './EditorToolbar.vue';
import { SHORTCUTS, caretStyle, runCommand, toolbarState } from './toolbar';

// Synthetic fixture text only.
const DOC: JSONContent = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Alpha title' }] },
    {
      type: 'paragraph',
      attrs: { style: 'body' },
      content: [
        { type: 'text', text: 'plain ' },
        { type: 'text', marks: [{ type: 'bold' }], text: 'strong' },
        { type: 'text', text: ' words' },
      ],
    },
    { type: 'paragraph', attrs: { style: 'block_quote' }, content: [{ type: 'text', text: 'q' }] },
  ],
};

const editors: Editor[] = [];
function make(content: JSONContent = DOC) {
  const e = new Editor({
    ...manuscriptEditorOptions({ content }),
    element: document.createElement('div'),
  });
  editors.push(e);
  return e;
}
/** Put the caret inside the first occurrence of `text`. */
function caretIn(e: Editor, text: string, offset = 1) {
  let pos = -1;
  e.state.doc.descendants((n, p) => {
    if (pos < 0 && n.isText && n.text!.includes(text)) pos = p + n.text!.indexOf(text) + offset;
  });
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, pos)));
}
function select(e: Editor, text: string) {
  let from = -1;
  e.state.doc.descendants((n, p) => {
    if (from < 0 && n.isText && n.text!.includes(text)) from = p + n.text!.indexOf(text);
  });
  e.view.dispatch(
    e.state.tr.setSelection(TextSelection.create(e.state.doc, from, from + text.length)),
  );
}
afterEach(() => editors.splice(0).forEach((e) => e.destroy()));

describe('toolbar state', () => {
  it('reports the style at the caret', () => {
    const e = make();
    caretIn(e, 'Alpha');
    expect(caretStyle(e)).toBe('heading');
    caretIn(e, 'plain');
    expect(caretStyle(e)).toBe('body');
    caretIn(e, 'q', 0);
    expect(caretStyle(e)).toBe('block_quote');
  });

  it('reports a selected scene break', () => {
    const e = make({
      type: 'doc',
      content: [{ type: 'paragraph' }, { type: 'scene_break' }, { type: 'paragraph' }],
    });
    e.view.dispatch(e.state.tr.setSelection(NodeSelection.create(e.state.doc, 2)));
    expect(caretStyle(e)).toBe('scene_break');
  });

  it('marks Bold active only inside bold text', () => {
    const e = make();
    caretIn(e, 'strong', 2);
    expect(toolbarState(e).bold).toBe(true);
    caretIn(e, 'plain', 2);
    expect(toolbarState(e).bold).toBe(false);
  });

  it('has no undo history when unbound, and real undo/redo when bound to a Y.Doc', async () => {
    const flush = () => new Promise((r) => setTimeout(r, 0));
    expect(toolbarState(make()).canUndo).toBe(false);
    const doc = docToYDoc(structuredClone(DOC) as never);
    const e = new Editor({
      ...collaborativeEditorOptions(doc, { element: document.createElement('div') }),
    });
    editors.push(e);
    await flush();
    e.commands.insertContent('typed');
    await flush();
    expect(e.getText()).toContain('typed');
    expect(toolbarState(e).canUndo).toBe(true);
    expect(runCommand(e, 'undo')).toBe(true);
    await flush();
    expect(e.getText()).not.toContain('typed');
    expect(toolbarState(e).canRedo).toBe(true);
    runCommand(e, 'redo');
    await flush();
    expect(e.getText()).toContain('typed');
  });
});

describe('toolbar commands', () => {
  it('keeps suggestion marks and their attrs when formatting suggested text', () => {
    const by = { author: 'agent:sample', ts: '2026-10-25T00:00:00Z' };
    const ins = { type: 'suggestion_insert', attrs: { id: 's1', ...by } };
    const del = { type: 'suggestion_delete', attrs: { id: 's1', ...by } };
    const e = make({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { style: 'body' },
          content: [
            { type: 'text', text: 'The ' },
            { type: 'text', marks: [del], text: 'grey' },
            { type: 'text', marks: [ins], text: 'silver' },
            { type: 'text', text: ' kettle.' },
          ],
        },
      ],
    });
    const marksOf = (text: string) => {
      const found: { type: string; attrs: Record<string, unknown> }[] = [];
      e.state.doc.descendants((n) => {
        if (n.isText && n.text === text)
          for (const m of n.marks) found.push({ type: m.type.name, attrs: { ...m.attrs } });
      });
      return found;
    };
    select(e, 'greysilver'.slice(0, 4));
    const from = e.state.selection.from;
    e.view.dispatch(
      e.state.tr.setSelection(TextSelection.create(e.state.doc, from, from + 'greysilver'.length)),
    );
    expect(runCommand(e, 'bold')).toBe(true);
    expect(runCommand(e, 'style:block_quote')).toBe(true);
    expect(caretStyle(e)).toBe('block_quote');
    const g = marksOf('grey');
    const sv = marksOf('silver');
    expect(g).toContainEqual(del);
    expect(sv).toContainEqual(ins);
    expect(g.map((m) => m.type)).toContain('bold');
    expect(sv.map((m) => m.type)).toContain('bold');
  });

  it('never edits a read-only editor', () => {
    const e = make();
    select(e, 'plain');
    e.setEditable(false, false);
    const before = JSON.stringify(e.getJSON());
    for (const c of [
      'bold',
      'italic',
      'style:heading',
      'style:scene_break',
      'align:center',
      'pageBreak',
    ] as const)
      expect(runCommand(e, c)).toBe(false);
    expect(JSON.stringify(e.getJSON())).toBe(before);
  });

  it('toggles bold, italic and underline on the selection', () => {
    const e = make();
    select(e, 'plain');
    runCommand(e, 'bold');
    runCommand(e, 'italic');
    runCommand(e, 'underline');
    const s = toolbarState(e);
    expect([s.bold, s.italic, s.underline]).toEqual([true, true, true]);
    runCommand(e, 'underline');
    expect(toolbarState(e).underline).toBe(false);
  });

  it('switches between Body, Heading and Block quote', () => {
    const e = make();
    caretIn(e, 'plain');
    runCommand(e, 'style:heading');
    expect(caretStyle(e)).toBe('heading');
    runCommand(e, 'style:body');
    expect(caretStyle(e)).toBe('body');
    runCommand(e, 'style:block_quote');
    expect(caretStyle(e)).toBe('block_quote');
    caretIn(e, 'Alpha');
    runCommand(e, 'style:block_quote');
    expect(e.state.doc.firstChild!.type.name).toBe('paragraph');
    expect(caretStyle(e)).toBe('block_quote');
  });

  it('inserts a scene break', () => {
    const e = make();
    caretIn(e, 'words', 5);
    runCommand(e, 'style:scene_break');
    let breaks = 0;
    e.state.doc.descendants((n) => void (n.type.name === 'scene_break' && breaks++));
    expect(breaks).toBe(1);
  });

  it('aligns left and center through the paragraph style', () => {
    const e = make();
    caretIn(e, 'plain');
    runCommand(e, 'align:center');
    expect(toolbarState(e).align).toBe('center');
    runCommand(e, 'align:left');
    expect(toolbarState(e).align).toBe('left');
    expect(caretStyle(e)).toBe('body');
    expect(runCommand(e, 'align:right')).toBe(false);
  });
});

describe('EditorToolbar', () => {
  function mountBar(props: Record<string, unknown> = {}) {
    const e = make();
    const w = mount(EditorToolbar, { props: { editor: e, ...props }, attachTo: document.body });
    return { e, w };
  }

  it('lays out Wave 6a groups in D1 order (245)', () => {
    const { w } = mountBar({ manuscriptId: 'm1' });
    expect(w.find('[data-test="draft-picker"]').exists()).toBe(true);
    expect(w.find('[data-test="toolbar-undo"]').exists()).toBe(true);
    expect(w.find('[data-test="track-changes-toggle"]').exists()).toBe(true);
    expect(w.find('[data-test="review-panel-toggle"]').exists()).toBe(true);
    expect(w.find('[data-test="toolbar-export"]').exists()).toBe(true);
    expect(w.find('[data-test="toolbar-agents"]').exists()).toBe(true);
    expect(w.find('[data-test="toolbar-theme"]').exists()).toBe(true);
    expect(w.find('[data-test="toolbar-settings"]').exists()).toBe(true);
    const bar = w.get('[data-test="editor-toolbar"]');
    const topLevelNav = [...bar.element.children].some(
      (el) => (el as HTMLElement).dataset.test === 'tb-navigator',
    );
    expect(topLevelNav).toBe(false);
    w.unmount();
  });

  it('gives every top-level control an accessible name and a tooltip', () => {
    const { w } = mountBar({ manuscriptId: 'm1' });
    for (const b of w.findAll(
      '[data-test="editor-toolbar"] > button, [data-test="editor-toolbar"] > div > button, [data-test="draft-picker"]',
    )) {
      expect(b.attributes('aria-label') || b.attributes('title')).toBeTruthy();
    }
    expect(w.find('[data-test="tb-bold"]').attributes('title')).toBe(`Bold (${SHORTCUTS.bold})`);
    // Unbound editor: no history, so no Ctrl+Z/Ctrl+Y hint.
    expect(w.find('[data-test="toolbar-undo"]').attributes('title')).toBe('Undo');
    expect(w.find('[data-test="toolbar-undo"]').attributes('aria-keyshortcuts')).toBeUndefined();
    expect(w.find('[data-test="tb-find"]').attributes('title')).toBe('Find — coming soon');
    w.unmount();
  });

  it('shows the caret style and follows the caret', async () => {
    const { e, w } = mountBar();
    caretIn(e, 'Alpha');
    await flushPromises();
    const sel = w.find('[data-test="paragraph-style"]').element as HTMLSelectElement;
    expect(sel.value).toBe('heading');
    caretIn(e, 'q', 0);
    await flushPromises();
    expect(sel.value).toBe('block_quote');
    w.unmount();
  });

  it('sets aria-pressed on Bold in bold text and runs commands on click', async () => {
    const { e, w } = mountBar();
    caretIn(e, 'strong', 2);
    await flushPromises();
    expect(w.find('[data-test="tb-bold"]').attributes('aria-pressed')).toBe('true');
    select(e, 'plain');
    await w.find('[data-test="tb-italic"]').trigger('click');
    expect(w.find('[data-test="tb-italic"]').attributes('aria-pressed')).toBe('true');
    w.unmount();
  });

  it('puts less-common actions in the overflow menu', async () => {
    const { e, w } = mountBar();
    select(e, 'plain');
    expect(w.find('[data-test="tb-overflow-menu"]').isVisible()).toBe(false);
    await w.find('[data-test="tb-overflow"]').trigger('click');
    expect(w.find('[data-test="tb-overflow"]').attributes('aria-expanded')).toBe('true');
    const items = w
      .find('[data-test="tb-overflow-menu"]')
      .findAll('[role^="menuitem"]')
      .map((i) => i.text());
    expect(items).toEqual([
      'Small caps',
      'Strikethrough',
      'First paragraph',
      'Epigraph',
      'Verse',
      'Insert page break',
    ]);
    await w.find('[data-test="tb-menu-smallcaps"]').trigger('click');
    expect(toolbarState(e).smallcaps).toBe(true);
    expect(w.find('[data-test="tb-overflow-menu"]').isVisible()).toBe(false);
    w.unmount();
  });

  it('emits the panel toggles; unbuilt actions are aria-disabled no-ops', async () => {
    const { w } = mountBar({ reviewOpen: false });
    await w.find('[data-test="review-panel-toggle"]').trigger('click');
    expect(w.emitted('toggle-review')).toHaveLength(1);
    expect(w.find('[data-test="review-panel-toggle"]').attributes('aria-pressed')).toBe('false');
    const nav = w.find('[data-test="tb-overflow"]');
    expect(nav.exists()).toBe(true);
    await w.find('[data-test="tb-overflow"]').trigger('click');
    const chapters = w.find('[data-test="tb-navigator"]');
    expect(chapters.attributes('aria-pressed')).toBe('true');
    expect(chapters.attributes('aria-disabled')).toBeUndefined();
    await chapters.trigger('click');
    expect(w.emitted('toggle-navigator')).toHaveLength(1);
    for (const id of ['tb-comment', 'tb-find', 'tb-align-right', 'tb-align-justify']) {
      const b = w.find(`[data-test="${id}"]`);
      expect(b.attributes('disabled')).toBeUndefined(); // stays in the Tab order
      expect(b.attributes('aria-disabled')).toBe('true');
      expect(b.attributes('aria-description')).toBe('coming soon');
      expect(b.attributes('title')).toMatch(/ — coming soon$/);
      await b.trigger('click');
    }
    expect(w.find('[data-test="tb-comment"]').attributes('title')).toBe(
      'Add comment — coming soon',
    );
    expect(w.emitted('comment')).toBeUndefined();
    expect(w.emitted('find')).toBeUndefined();
    w.unmount();
  });

  it('advertises only shortcuts that are really bound', () => {
    const { w } = mountBar();
    const titles = w.findAll('[title]').map((el) => el.attributes('title')!);
    const keys = w.findAll('[aria-keyshortcuts]').map((el) => el.attributes('aria-keyshortcuts'));
    expect(keys).toEqual(['Control+B', 'Control+I', 'Control+U']);
    for (const t of titles) expect(t).not.toMatch(/Ctrl\+(?:[LERJ\\FYZ]\b|Alt)/);
    expect(w.find('[data-test="tb-align-left"]').attributes('title')).toBe('Align left');
    w.unmount();
  });

  it('shows Ctrl+Z/Ctrl+Y only when the editor has undo history', () => {
    const e = new Editor(
      collaborativeEditorOptions(docToYDoc(structuredClone(DOC) as never), {
        element: document.createElement('div'),
      }),
    );
    editors.push(e);
    const w = mount(EditorToolbar, { props: { editor: e } });
    expect(w.find('[data-test="toolbar-undo"]').attributes('title')).toBe('Undo (Ctrl+Z)');
    expect(w.find('[data-test="toolbar-redo"]').attributes('aria-keyshortcuts')).toBe('Control+Y');
    w.unmount();
  });

  it('undo/redo: read-only is aria-disabled, focusable and inert; editable with no history is natively disabled', async () => {
    const e = new Editor(
      collaborativeEditorOptions(docToYDoc(structuredClone(DOC) as never), {
        element: document.createElement('div'),
      }),
    );
    editors.push(e);
    const w = mount(EditorToolbar, {
      props: { editor: e, readOnlyReason: 'document failed to load' },
      attachTo: document.body,
    });
    await flushPromises();
    for (const id of ['toolbar-undo', 'toolbar-redo']) {
      const c = w.find(`[data-test="${id}"]`);
      expect(c.attributes('disabled')).toBeDefined();
      expect(c.attributes('aria-disabled')).toBeUndefined();
    }
    e.commands.insertContent('x');
    await new Promise((r) => setTimeout(r, 0));
    e.setEditable(false, false);
    await flushPromises();
    await new Promise((r) => setTimeout(r, 0));
    const before = JSON.stringify(e.getJSON());
    for (const id of ['toolbar-undo', 'toolbar-redo']) {
      const c = w.find(`[data-test="${id}"]`);
      expect(c.attributes('disabled')).toBeUndefined();
      expect(c.attributes('aria-disabled')).toBe('true');
      expect(c.attributes('title')).toBe('Read-only: document failed to load');
      expect(c.attributes('aria-description')).toBe('Read-only: document failed to load');
      expect(c.attributes('aria-keyshortcuts')).toBeUndefined();
      (c.element as HTMLElement).focus();
      expect(document.activeElement).toBe(c.element);
      await c.trigger('click');
      await c.trigger('keydown', { key: 'Enter' });
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.stringify(e.getJSON())).toBe(before);
    w.unmount();
  });

  it('binds the advertised B/I/U keys in the editor', () => {
    const e = make();
    select(e, 'plain');
    const press = (key: string) =>
      e.view.someProp('handleKeyDown', (f) =>
        f(e.view, new KeyboardEvent('keydown', { key, ctrlKey: true })),
      );
    press('b');
    press('i');
    press('u');
    const s = toolbarState(e);
    expect([s.bold, s.italic, s.underline]).toEqual([true, true, true]);
  });

  it('enables wired comment and find', async () => {
    const { w } = mountBar({ commentEnabled: true, findEnabled: true });
    await w.find('[data-test="tb-comment"]').trigger('click');
    await w.find('[data-test="tb-find"]').trigger('click');
    expect(w.emitted('comment')).toHaveLength(1);
    expect(w.emitted('find')).toHaveLength(1);
    expect(w.find('[data-test="tb-find"]').attributes('aria-disabled')).toBeUndefined();
    w.unmount();
  });

  const FORMAT = [
    'tb-bold',
    'tb-italic',
    'tb-underline',
    'tb-align-left',
    'tb-align-center',
    'paragraph-style',
  ];

  it('read-only: formatting stays focusable, aria-disabled, inert, and says Read-only', async () => {
    const { e, w } = mountBar({ readOnlyReason: 'document failed to load' });
    select(e, 'plain');
    await flushPromises();
    expect(w.find('[data-test="tb-bold"]').attributes('title')).toBe('Bold (Ctrl+B)');
    e.setEditable(false, false); // no 'update' emitted, like the load-error path
    await flushPromises();
    await new Promise((r) => setTimeout(r, 0));
    const before = JSON.stringify(e.getJSON());
    for (const id of FORMAT) {
      const c = w.find(`[data-test="${id}"]`);
      expect(c.attributes('disabled')).toBeUndefined();
      expect(c.attributes('aria-disabled')).toBe('true');
      expect(c.attributes('title')).toBe('Read-only: document failed to load');
      expect(c.attributes('aria-description')).toBe('Read-only: document failed to load');
      expect(c.attributes('aria-keyshortcuts')).toBeUndefined();
      (c.element as HTMLElement).focus();
      expect(document.activeElement).toBe(c.element);
      if (id !== 'paragraph-style') {
        await c.trigger('click');
        await c.trigger('keydown', { key: 'Enter' });
      }
    }
    const sel = w.find('[data-test="paragraph-style"]');
    const shown = (sel.element as HTMLSelectElement).value;
    await sel.setValue('heading');
    expect((sel.element as HTMLSelectElement).value).toBe(shown);
    expect(toolbarState(e).bold).toBe(false);
    for (const id of ['toolbar-undo', 'toolbar-redo'])
      expect(w.find(`[data-test="${id}"]`).attributes('aria-disabled')).toBe('true');
    await w.find('[data-test="tb-overflow"]').trigger('click');
    for (const i of w.find('[data-test="tb-overflow-menu"]').findAll('[role^="menuitem"]')) {
      expect(i.attributes('disabled')).toBeUndefined();
      expect(i.attributes('aria-disabled')).toBe('true');
      expect(i.attributes('title')).toBe('Read-only: document failed to load');
    }
    await w.find('[data-test="tb-menu-smallcaps"]').trigger('click');
    expect(JSON.stringify(e.getJSON())).toBe(before);
    e.setEditable(true);
    await flushPromises();
    await new Promise((r) => setTimeout(r, 0));
    for (const id of FORMAT)
      expect(w.find(`[data-test="${id}"]`).attributes('aria-disabled')).toBeUndefined();
    expect(w.find('[data-test="tb-bold"]').attributes('title')).toBe('Bold (Ctrl+B)');
    w.unmount();
  });

  it('read-only without a reason says editing is turned off', async () => {
    const { e, w } = mountBar();
    e.setEditable(false, false);
    await flushPromises();
    await new Promise((r) => setTimeout(r, 0));
    expect(w.find('[data-test="tb-italic"]').attributes('title')).toBe(
      'Read-only: editing is turned off',
    );
    w.unmount();
  });

  it('overflow: arrow/Home/End navigation, Esc refocuses the button, outside click closes', async () => {
    const { w } = mountBar();
    const more = w.find('[data-test="tb-overflow"]');
    await more.trigger('click');
    await flushPromises();
    const items = () =>
      w
        .find('[data-test="tb-overflow-menu"]')
        .findAll('[role^="menuitem"]')
        .map((i) => i.element);
    const menu = w.find('[data-test="tb-overflow-menu"]');
    expect(document.activeElement).toBe(items()[0]);
    await menu.trigger('keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items()[1]);
    await menu.trigger('keydown', { key: 'End' });
    expect(document.activeElement).toBe(items()[5]);
    await menu.trigger('keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items()[0]);
    await menu.trigger('keydown', { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items()[5]);
    await menu.trigger('keydown', { key: 'Home' });
    expect(document.activeElement).toBe(items()[0]);
    await menu.trigger('keydown', { key: 'Escape' });
    expect(w.find('[data-test="tb-overflow-menu"]').isVisible()).toBe(false);
    expect(document.activeElement).toBe(more.element);
    await more.trigger('click');
    expect(w.find('[data-test="tb-overflow-menu"]').isVisible()).toBe(true);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await flushPromises();
    expect(w.find('[data-test="tb-overflow-menu"]').isVisible()).toBe(false);
    w.unmount();
  });

  it('uses menuitemcheckbox with aria-checked for Small caps and Strikethrough', async () => {
    const { e, w } = mountBar();
    select(e, 'plain');
    await w.find('[data-test="tb-overflow"]').trigger('click');
    const roles = w
      .find('[data-test="tb-overflow-menu"]')
      .findAll('[role^="menuitem"]')
      .map((i) => i.attributes('role'));
    expect(roles).toEqual([
      'menuitemcheckbox',
      'menuitemcheckbox',
      'menuitem',
      'menuitem',
      'menuitem',
      'menuitem',
    ]);
    expect(w.find('[data-test="tb-menu-smallcaps"]').attributes('aria-checked')).toBe('false');
    expect(w.find('[data-test="tb-menu-style-first"]').attributes('aria-checked')).toBeUndefined();
    await w.find('[data-test="tb-menu-smallcaps"]').trigger('click');
    await w.find('[data-test="tb-overflow"]').trigger('click');
    expect(w.find('[data-test="tb-menu-smallcaps"]').attributes('aria-checked')).toBe('true');
    w.unmount();
  });

  it('uses no hard-coded colors', async () => {
    const src = (await import('./EditorToolbar.vue?raw')).default as string;
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
    expect(src).not.toMatch(/\b(?:bg|text|border)-(?:white|black|gray|slate|blue|red)\b/);
  });
});
