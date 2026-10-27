import { undoDepth as pmUndoDepth } from '@tiptap/pm/history';
import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ManuscriptEditor from './ManuscriptEditor.vue';
import { SAMPLE_DOC } from './fixtures/sample';

describe('ManuscriptEditor', () => {
  it('accept/reject shortcuts do nothing while focus mode hides the review panel (#44)', async () => {
    const w = mount(ManuscriptEditor, { props: { content: SAMPLE_DOC }, attachTo: document.body });
    await flushPromises();
    const html = () => w.find('.tiptap').html();
    const fire = (key: string) =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key, ctrlKey: true, shiftKey: true, bubbles: true }),
      );
    await w.find('[data-test="focus-mode"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="review"]').exists()).toBe(false);
    const before = html();
    for (const key of ['Enter', 'Backspace']) {
      fire(key);
      await flushPromises();
      expect(html()).toBe(before);
      expect(w.find('.tiptap ins.suggestion-insert').exists()).toBe(true);
      expect(w.find('.tiptap del.suggestion-delete').exists()).toBe(true);
    }
    // Control: once focus mode is off the same shortcut does act.
    await w.find('[data-test="focus-exit"]').trigger('click');
    await flushPromises();
    fire('Enter');
    await flushPromises();
    expect(w.find('.tiptap ins.suggestion-insert').exists()).toBe(false);
    w.unmount();
  });

  it('renders the document with tracked changes in the review panel and comments below it', async () => {
    const w = mount(ManuscriptEditor, { props: { content: SAMPLE_DOC }, attachTo: document.body });
    await flushPromises();
    const page = w.find('.tiptap');
    expect(page.find('ins.suggestion-insert').text()).toBe('guttered');
    expect(page.find('del.suggestion-delete').text()).toBe('flickered');
    expect(page.find('.comment-anchor').text()).toBe('rain');
    expect(page.find('.scene-break').exists()).toBe(true);
    // The replacement is one card with an inline diff.
    const cards = w.findAll('[data-test="item"]');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.find('[data-test=del]').text()).toBe('flickered');
    expect(cards[0]!.find('[data-test=ins]').text()).toBe('guttered');
    expect(w.find('[data-test="counter"]').text()).toBe('1 of 1');
    const items = w.findAll('[data-test="review-item"]').map((i) => i.text());
    expect(items).toHaveLength(1);
    expect(items[0]).toContain('Comment');
    // Comments stay read-only; only suggestions get Accept/Reject.
    expect(w.find('.comments button').exists()).toBe(false);
    w.unmount();
  });

  it('shows the chapter label above the page as display only, never in the document', async () => {
    const w = mount(ManuscriptEditor, {
      props: { content: SAMPLE_DOC, chapterLabel: 'Chapter Three' },
      attachTo: document.body,
    });
    await flushPromises();
    const label = w.find('[data-test="chapter-label"]');
    expect(label.exists()).toBe(true);
    expect(label.text()).toBe('Chapter Three');
    expect(label.attributes('aria-hidden')).toBe('true');
    // Outside the editable area and absent from the editor's document and history.
    expect(label.element.closest('.tiptap')).toBeNull();
    expect(w.find('.tiptap').text()).not.toContain('Chapter Three');
    expect(w.emitted('change')).toBeUndefined();
    w.unmount();
  });

  it('offers the four toolbar paragraph styles', async () => {
    const w = mount(ManuscriptEditor, { props: { content: SAMPLE_DOC }, attachTo: document.body });
    await flushPromises();
    const options = w
      .findAll('[data-test="paragraph-style"] option')
      .map((o) => o.attributes('value'));
    expect(options.slice(0, 4)).toEqual(['body', 'heading', 'scene_break', 'block_quote']);
    w.unmount();
  });

  it('inserts a scene break and reports the change', async () => {
    const w = mount(ManuscriptEditor, { props: { content: SAMPLE_DOC }, attachTo: document.body });
    await flushPromises();
    await w.find('[data-test="paragraph-style"]').setValue('scene_break');
    const changes = w.emitted('change');
    expect(changes?.length).toBeGreaterThan(0);
    expect(w.findAll('.tiptap .scene-break')).toHaveLength(2);
    w.unmount();
  });

  it('refuses content outside the schema with a visible error and never emits it', async () => {
    const bad = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'keep', marks: [{ type: 'mystery_mark' }] }],
        },
        { type: 'table' },
      ],
    };
    const w = mount(ManuscriptEditor, { props: { content: bad }, attachTo: document.body });
    await flushPromises();
    expect(w.find('[data-test="load-error"]').exists()).toBe(true);
    expect(w.emitted('change')).toBeUndefined();
    expect(w.find('.tiptap').attributes('contenteditable')).toBe('false');
    const bold = w.find('[data-test="tb-bold"]');
    expect(bold.attributes('aria-disabled')).toBe('true');
    expect(bold.attributes('title')).toBe('Read-only: document failed to load');
    await w.find('[data-test="reload"]').trigger('click');
    expect(w.emitted('reload')).toHaveLength(1);
    w.unmount();
  });

  it('opens with the cursor in the first body paragraph, after the heading', async () => {
    const content = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Chapter One' }] },
        { type: 'paragraph', attrs: { style: 'body' }, content: [{ type: 'text', text: 'Body.' }] },
      ],
    };
    const w = mount(ManuscriptEditor, { props: { content }, attachTo: document.body });
    await flushPromises();
    await new Promise((r) => setTimeout(r, 0));
    const editor = (
      w.find('.tiptap').element as unknown as { editor: import('@tiptap/core').Editor }
    ).editor;
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph');
    editor.view.dispatch(editor.state.tr.insertText('X')); // what a keystroke does
    expect(editor.state.doc.child(0).textContent).toBe('Chapter One');
    expect(editor.state.doc.child(1).textContent).toBe('XBody.');
    w.unmount();
  });

  const heading = (text: string) => ({
    type: 'heading',
    attrs: { level: 1 },
    content: [{ type: 'text', text }],
  });
  async function mounted(content: object) {
    const w = mount(ManuscriptEditor, { props: { content }, attachTo: document.body });
    await flushPromises();
    await new Promise((r) => setTimeout(r, 0));
    const editor = (
      w.find('.tiptap').element as unknown as { editor: import('@tiptap/core').Editor }
    ).editor;
    return { w, editor };
  }

  it('focusBody focuses and puts the cursor at the start of the first body paragraph', async () => {
    const { w, editor } = await mounted({
      type: 'doc',
      content: [
        heading('Synthetic Heading'),
        {
          type: 'paragraph',
          attrs: { style: 'body' },
          content: [{ type: 'text', text: 'Alpha.' }],
        },
        { type: 'paragraph', attrs: { style: 'body' }, content: [{ type: 'text', text: 'Beta.' }] },
      ],
    });
    editor.commands.setTextSelection(editor.state.doc.content.size - 1); // author moved away
    (w.vm as unknown as { focusBody: () => void }).focusBody();
    await new Promise((r) => setTimeout(r, 0));
    expect(editor.isFocused).toBe(true);
    expect(editor.state.selection.$from.parent.textContent).toBe('Alpha.');
    expect(editor.state.selection.$from.parentOffset).toBe(0);
    expect(editor.state.doc.childCount).toBe(3);
    w.unmount();
  });

  it('focusBody on a heading-only section moves only the cursor, to the end of the heading', async () => {
    const { w, editor } = await mounted({
      type: 'doc',
      content: [heading('Synthetic Heading'), { type: 'scene_break' }],
    });
    const before = editor.state.doc;
    const undoDepth = () => pmUndoDepth(editor.state);
    const couldUndo = undoDepth();
    const focus = (w.vm as unknown as { focusBody: () => void }).focusBody;
    focus();
    focus();
    await new Promise((r) => setTimeout(r, 0));
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(undoDepth()).toBe(couldUndo);
    const { $from, empty } = editor.state.selection;
    expect(empty).toBe(true);
    expect($from.parent.textContent).toBe('Synthetic Heading');
    expect($from.parentOffset).toBe('Synthetic Heading'.length);
    expect(editor.isFocused).toBe(true);
    w.unmount();
  });

  it('focusBody on a read-only editor focuses without changing the text', async () => {
    const content = { type: 'doc', content: [heading('Synthetic Heading')] };
    const w = mount(ManuscriptEditor, {
      props: { content, readonly: true },
      attachTo: document.body,
    });
    await flushPromises();
    const editor = (
      w.find('.tiptap').element as unknown as { editor: import('@tiptap/core').Editor }
    ).editor;
    (w.vm as unknown as { focusBody: () => void }).focusBody();
    await new Promise((r) => setTimeout(r, 0));
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.isEditable).toBe(false);
    const before = editor.state.doc;
    expect(editor.view.dom.getAttribute('contenteditable')).toBe('false');
    await typeThroughDom(editor, 'Synthetic attempt');
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(editor.getText()).not.toContain('Synthetic attempt');
    w.unmount();
  });

  it('control: the same DOM typing does change an editable editor', async () => {
    const content = { type: 'doc', content: [heading('Synthetic Heading')] };
    const w = mount(ManuscriptEditor, { props: { content }, attachTo: document.body });
    await flushPromises();
    const editor = (
      w.find('.tiptap').element as unknown as { editor: import('@tiptap/core').Editor }
    ).editor;
    (w.vm as unknown as { focusBody: () => void }).focusBody();
    await new Promise((r) => setTimeout(r, 0));
    expect(editor.isEditable).toBe(true);
    const before = editor.state.doc;
    await typeThroughDom(editor, 'Synthetic attempt');
    expect(editor.state.doc.eq(before)).toBe(false);
    expect(editor.getText()).toContain('Synthetic attempt');
    w.unmount();
  });
});

/**
 * Type the way a browser does: change the text in the editor's DOM and let ProseMirror read the
 * mutation (its DOM-change input path, which honours read-only). jsdom does not insert text for
 * synthetic key events, and editor commands bypass read-only, so neither proves anything.
 */
async function typeThroughDom(editor: import('@tiptap/core').Editor, text: string) {
  let node: Node | null = editor.view.dom;
  while (node && node.nodeType !== Node.TEXT_NODE) node = node.firstChild;
  if (!node) throw new Error('no text node to type into');
  (node as Text).data += text;
  (editor.view as unknown as { domObserver: { flush(): void } }).domObserver.flush();
  await flushPromises();
}
