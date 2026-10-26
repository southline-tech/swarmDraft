import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ManuscriptEditor from './ManuscriptEditor.vue';
import { SAMPLE_DOC } from './fixtures/sample';

describe('ManuscriptEditor', () => {
  it('renders the document with tracked changes and comments, read-only in the review list', async () => {
    const w = mount(ManuscriptEditor, { props: { content: SAMPLE_DOC }, attachTo: document.body });
    await flushPromises();
    const page = w.find('.tiptap');
    expect(page.find('ins.suggestion-insert').text()).toBe('guttered');
    expect(page.find('del.suggestion-delete').text()).toBe('flickered');
    expect(page.find('.comment-anchor').text()).toBe('rain');
    expect(page.find('.scene-break').exists()).toBe(true);
    const items = w.findAll('[data-test="review-item"]').map((i) => i.text());
    expect(items).toHaveLength(3);
    expect(items[0]).toContain('Delete');
    expect(items[1]).toContain('Insert');
    expect(items[2]).toContain('Comment');
    expect(w.find('[data-test="review"] button').exists()).toBe(false);
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

  it('focusBody adds one empty body paragraph after a lone heading, keeping the heading', async () => {
    const { w, editor } = await mounted({
      type: 'doc',
      content: [heading('Synthetic Heading'), { type: 'scene_break' }],
    });
    const focus = (w.vm as unknown as { focusBody: () => void }).focusBody;
    focus();
    focus(); // a second click must not add another paragraph
    await new Promise((r) => setTimeout(r, 0));
    const { doc } = editor.state;
    expect(doc.childCount).toBe(3);
    expect(doc.child(0).textContent).toBe('Synthetic Heading');
    expect(doc.child(1).type.name).toBe('paragraph');
    expect(doc.child(1).attrs.style).toBe('body');
    expect(doc.child(2).type.name).toBe('scene_break');
    expect(editor.state.selection.$from.index(0)).toBe(1);
    expect(editor.isFocused).toBe(true);
    editor.view.dispatch(editor.state.tr.insertText('Typed'));
    expect(editor.state.doc.child(0).textContent).toBe('Synthetic Heading');
    expect(editor.state.doc.child(1).textContent).toBe('Typed');
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
    w.unmount();
  });
});
