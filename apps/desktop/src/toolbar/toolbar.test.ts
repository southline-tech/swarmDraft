import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { Editor, type JSONContent } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { docToYDoc } from '@coauthor/docx';
import { collaborativeEditorOptions, manuscriptEditorOptions } from '@coauthor/editor';
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

  it('lays out the groups in the specified order', () => {
    const { w } = mountBar();
    const order = w
      .find('[role="toolbar"]')
      .element.querySelectorAll('[data-test], [aria-hidden="true"].bg-border');
    const seq = [...order].map((el) => el.getAttribute('data-test') ?? '|');
    expect(seq).toEqual([
      'tb-navigator',
      '|',
      'tb-undo',
      'tb-redo',
      '|',
      'paragraph-style',
      '|',
      'tb-bold',
      'tb-italic',
      'tb-underline',
      '|',
      'tb-align-left',
      'tb-align-center',
      'tb-align-right',
      'tb-align-justify',
      '|',
      'tb-comment',
      'tb-overflow',
      'tb-find',
      '|',
      'tb-review',
    ]);
    w.unmount();
  });

  it('gives every button an accessible name and a tooltip with its shortcut', () => {
    const { w } = mountBar();
    for (const b of w.findAll('[role="toolbar"] > button, [role="toolbar"] > div > button')) {
      expect(b.attributes('aria-label')).toBeTruthy();
      expect(b.attributes('title')).toBeTruthy();
    }
    expect(w.find('[data-test="tb-bold"]').attributes('title')).toBe(`Bold (${SHORTCUTS.bold})`);
    expect(w.find('[data-test="tb-undo"]').attributes('title')).toBe('Undo (Ctrl+Z)');
    expect(w.find('[data-test="tb-find"]').attributes('title')).toBe('Find (Ctrl+F)');
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
    expect(w.find('[data-test="tb-overflow-menu"]').exists()).toBe(false);
    await w.find('[data-test="tb-overflow"]').trigger('click');
    expect(w.find('[data-test="tb-overflow"]').attributes('aria-expanded')).toBe('true');
    const items = w.findAll('[role="menuitem"]').map((i) => i.text());
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
    expect(w.find('[data-test="tb-overflow-menu"]').exists()).toBe(false);
    w.unmount();
  });

  it('emits the panel toggles and keeps unwired actions disabled', async () => {
    const { w } = mountBar({ reviewOpen: false });
    await w.find('[data-test="tb-navigator"]').trigger('click');
    await w.find('[data-test="tb-review"]').trigger('click');
    expect(w.emitted('toggle-navigator')).toHaveLength(1);
    expect(w.emitted('toggle-review')).toHaveLength(1);
    expect(w.find('[data-test="tb-review"]').attributes('aria-pressed')).toBe('false');
    expect(w.find('[data-test="tb-comment"]').attributes('disabled')).toBeDefined();
    expect(w.find('[data-test="tb-find"]').attributes('disabled')).toBeDefined();
    w.unmount();
  });

  it('uses no hard-coded colors', async () => {
    const src = (await import('./EditorToolbar.vue?raw')).default as string;
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
    expect(src).not.toMatch(/\b(?:bg|text|border)-(?:white|black|gray|slate|blue|red)\b/);
  });
});
