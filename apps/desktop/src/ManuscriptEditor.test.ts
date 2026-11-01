import { undoDepth as pmUndoDepth } from '@tiptap/pm/history';
import { describe, expect, it, vi } from 'vitest';
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

  it('announces focus mode on and off in a polite live region (#55)', async () => {
    const w = mount(ManuscriptEditor, { props: { content: SAMPLE_DOC }, attachTo: document.body });
    await flushPromises();
    const live = () => w.get('[data-test="focus-mode-live"]');
    expect(live().attributes('aria-live')).toBe('polite');
    await w.find('[data-test="focus-mode"]').trigger('click');
    await flushPromises();
    expect(live().text()).toBe('Focus mode on.');
    await w.find('[data-test="focus-exit"]').trigger('click');
    await flushPromises();
    expect(live().text()).toBe('Focus mode off.');
    expect(document.activeElement?.closest('.ProseMirror')).not.toBeNull();
    w.unmount();
  });

  it('hides the empty-state cards while the section failed to load (looks like data loss)', async () => {
    const bad = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'keep', marks: [{ type: 'mystery_mark' }] }],
        },
      ],
    };
    const w = mount(ManuscriptEditor, { props: { content: bad }, attachTo: document.body });
    await flushPromises();
    // The error text lands in its live region one frame later (#79).
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    await flushPromises();
    expect(w.find('[data-test="load-error"]').exists()).toBe(true);
    expect(w.text()).not.toContain('Nothing to review');
    expect(w.text()).not.toContain('No comments yet');
    expect(w.findAll('[data-test="review"] .es')).toHaveLength(0);
    expect(w.find('[data-test="empty-load-failed"]').exists()).toBe(true);
    w.unmount();
  });

  it('shows icon-card empty states when there is nothing to review and no comments (ob8)', async () => {
    const plain = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Morning came late.' }] }],
    };
    const w = mount(ManuscriptEditor, { props: { content: plain }, attachTo: document.body });
    await flushPromises();
    const cards = w.findAll('[data-test="review"] .es');
    expect(cards.map((c) => c.find('h3').text())).toEqual(['Nothing to review', 'No comments yet']);
    expect(w.find('.comments').exists()).toBe(false);
    w.unmount();
  });

  it('renders the document with tracked changes in the review panel and comments below it', async () => {
    const w = mount(ManuscriptEditor, { props: { content: SAMPLE_DOC }, attachTo: document.body });
    await flushPromises();
    const page = w.find('.tiptap');
    expect(page.find('ins.suggestion-insert').text()).toBe('guttered');
    expect(page.find('del.suggestion-delete').text()).toBe('flickered');
    expect(page.find('.comment-anchor').text()).toBe('rain');
    const anchor = page.find('[data-test="comment-anchor"]');
    expect(anchor.exists()).toBe(true);
    expect(anchor.attributes('data-comment-id')).toBe('sample-c1');
    const sceneBreak = page.find('.scene-break');
    expect(sceneBreak.exists()).toBe(true);
    expect(sceneBreak.text()).toBe('* * *');
    // The replacement is one card with an inline diff.
    const cards = w.findAll('[data-test="item"]');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.find('[data-test=del]').text()).toBe('flickered');
    expect(cards[0]!.find('[data-test=ins]').text()).toBe('guttered');
    expect(w.find('[data-test="counter"]').text()).toBe('1 of 1');
    const items = w.findAll('[data-test="comment-row"]').map((i) => i.text());
    expect(items).toHaveLength(1);
    expect(items[0]).toContain('Comment');
    // Comments stay read-only; only suggestions get Accept/Reject.
    expect(w.find('.comments button').exists()).toBe(false);
    expect(w.find('[data-test="comments-empty"]').exists()).toBe(false);
    w.unmount();
  });

  it('applies selected comment-anchor styling when a comment row is clicked (#211)', async () => {
    const content = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              marks: [{ type: 'comment_anchor', attrs: { id: 'c1' } }],
              text: 'rain',
            },
          ],
        },
      ],
    };
    const w = mount(ManuscriptEditor, { props: { content }, attachTo: document.body });
    await flushPromises();
    await w.get('[data-test="comment-row"]').trigger('click');
    await flushPromises();
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    await flushPromises();
    const anchor = w.get('[data-test="comment-anchor"]').element as HTMLElement;
    expect(
      anchor.classList.contains('comment-anchor--selected') ||
        !!w.find('.comment-anchor--selected').exists(),
    ).toBe(true);
    w.unmount();
  });

  it('positions margin notes with absolute top from layout (#212)', async () => {
    const w = mount(ManuscriptEditor, { props: { content: SAMPLE_DOC }, attachTo: document.body });
    await flushPromises();
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    await flushPromises();
    const note = w.get('[data-test="margin-note"]').element as HTMLElement;
    expect(note.style.position).toBe('');
    expect(w.get('.sh-margin').classes()).not.toContain('flex');
    expect(note.style.top).toMatch(/^\d+(\.\d+)?px$/);
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
    // The error fills its assertive region one frame after it is set (#79).
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    await w.vm.$nextTick();
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

describe('inline toolbar shortcuts (#87 review)', () => {
  const fire = async (key: string, shiftKey: boolean) => {
    const w = mount(ManuscriptEditor, { props: { content: SAMPLE_DOC }, attachTo: document.body });
    await flushPromises();
    const ev = new KeyboardEvent('keydown', {
      key,
      ctrlKey: true,
      shiftKey,
      bubbles: true,
      cancelable: true,
    });
    const pd = vi.spyOn(ev, 'preventDefault');
    w.get('[data-test="tb-bold"]').element.dispatchEvent(ev);
    await flushPromises();
    return { w, pd };
  };

  it('Ctrl+Shift+F from an inline toolbar button toggles focus mode exactly once', async () => {
    const { w, pd } = await fire('F', true);
    expect(pd).toHaveBeenCalledTimes(1);
    expect(w.emitted('focus-mode')).toEqual([[true]]);
    expect(w.find('[data-focus-mode]').exists()).toBe(true);
    w.unmount();
  });

  it('Ctrl+F from an inline toolbar button opens Find exactly once', async () => {
    const { w, pd } = await fire('f', false);
    expect(pd).toHaveBeenCalledTimes(1);
    expect(w.find('[data-test="find-panel"]').exists()).toBe(true);
    w.unmount();
  });

  it('Ctrl+H opens Find with focus on replace', async () => {
    const { w, pd } = await fire('h', false);
    expect(pd).toHaveBeenCalledTimes(1);
    expect(w.find('[data-test="find-panel"]').exists()).toBe(true);
    await flushPromises();
    expect(document.activeElement?.getAttribute('data-test')).toBe('replace-input');
    w.unmount();
  });

  it('colors suggestion marks per author to match the review card dot (#48)', async () => {
    const sheet = document.createElement('style');
    sheet.textContent = `
      :root { --ct-collab-1: #2f5da8; --ct-collab-2: #a1452a; }
      :where([data-suggester]) {
        --ct-suggest-insert-underline: var(--ct-suggester);
      }
    `;
    document.head.appendChild(sheet);
    const { resetCollabSlots } = await import('./author-colors');
    resetCollabSlots();
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              marks: [
                {
                  type: 'suggestion_delete',
                  attrs: { id: 's1', author: 'agent:a', ts: 't' },
                },
              ],
              text: 'old',
            },
            {
              type: 'text',
              marks: [
                {
                  type: 'suggestion_insert',
                  attrs: { id: 's1', author: 'agent:a', ts: 't' },
                },
              ],
              text: 'new',
            },
            { type: 'text', text: ' and ' },
            {
              type: 'text',
              marks: [
                {
                  type: 'suggestion_insert',
                  attrs: { id: 's2', author: 'agent:b', ts: 't' },
                },
              ],
              text: 'extra',
            },
          ],
        },
      ],
    };
    const w = mount(ManuscriptEditor, { props: { content: doc }, attachTo: document.body });
    await flushPromises();
    const token = (el: HTMLElement) => el.style.getPropertyValue('--ct-suggester');
    const markEls = w
      .findAll(
        '.tiptap ins.suggestion-insert [data-suggester], .tiptap del.suggestion-delete [data-suggester]',
      )
      .map((n) => n.element as HTMLElement);
    expect(markEls.length).toBeGreaterThanOrEqual(2);
    const markTokens = markEls.map(token);
    expect(new Set(markTokens).size).toBe(2);
    const painted = markEls
      .filter((el) => el.closest('ins.suggestion-insert'))
      .map((el) => getComputedStyle(el).getPropertyValue('--ct-suggest-insert-underline').trim());
    expect(painted.length).toBeGreaterThanOrEqual(2);
    expect(new Set(painted).size).toBe(2);
    expect(w.find('[data-test="page"] .page').attributes('data-suggester')).toBeUndefined();
    const cardTokens = w.findAll('[data-test="item"]').map((c) => token(c.element as HTMLElement));
    expect(cardTokens).toHaveLength(2);
    for (const t of cardTokens) expect(markTokens).toContain(t);
    sheet.remove();
    w.unmount();
  });

  it('renders filtered-out deletions as plain body text in branch view (#50, #177)', async () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              marks: [
                {
                  type: 'suggestion_delete',
                  attrs: { id: 's1', author: 'agent:a', ts: 't' },
                },
              ],
              text: 'gone',
            },
            { type: 'text', text: ' ' },
            {
              type: 'text',
              marks: [
                {
                  type: 'suggestion_insert',
                  attrs: { id: 's2', author: 'agent:b', ts: 't' },
                },
              ],
              text: 'stay',
            },
          ],
        },
      ],
    };
    const w = mount(ManuscriptEditor, { props: { content: doc }, attachTo: document.body });
    await flushPromises();
    await w.findAll('[data-test="view-author"]')[1]!.trigger('click');
    await flushPromises();
    const hiddenDel = w.find('.tiptap .suggestion-filter-hidden-delete');
    expect(hiddenDel.exists()).toBe(true);
    expect(w.find('.tiptap .suggestion-filter-hidden-insert').exists()).toBe(false);
    const delWrap = w.find('.tiptap del.suggestion-delete').element as HTMLElement;
    const delText = hiddenDel.element as HTMLElement;
    const body = w.find('.tiptap p').element as HTMLElement;
    expect(getComputedStyle(delWrap).textDecorationLine).not.toMatch(/line-through/);
    expect(getComputedStyle(delText).textDecorationLine).not.toMatch(/line-through/);
    expect(getComputedStyle(delText).color).toBe(getComputedStyle(body).color);
    w.unmount();
  });

  it('hides inline marks for filtered-out authors and restores them on All (#50)', async () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              marks: [
                {
                  type: 'suggestion_insert',
                  attrs: { id: 's1', author: 'agent:a', ts: 't' },
                },
              ],
              text: 'alpha',
            },
            { type: 'text', text: ' ' },
            {
              type: 'text',
              marks: [
                {
                  type: 'suggestion_insert',
                  attrs: { id: 's2', author: 'agent:b', ts: 't' },
                },
              ],
              text: 'beta',
            },
          ],
        },
      ],
    };
    const w = mount(ManuscriptEditor, { props: { content: doc }, attachTo: document.body });
    await flushPromises();
    const editor = (
      w.vm as unknown as { $: { setupState: { editor: import('@tiptap/core').Editor } } }
    ).$.setupState.editor;
    const before = editor.state.doc;
    const undoBefore = pmUndoDepth(editor.state);
    const suggesters = () =>
      w.findAll(
        '.tiptap ins.suggestion-insert [data-suggester], .tiptap del.suggestion-delete [data-suggester]',
      );
    const hidden = () => w.findAll('.tiptap .suggestion-filter-hidden');
    expect(suggesters()).toHaveLength(2);
    expect(hidden()).toHaveLength(0);

    await w.findAll('[data-test="view-author"]')[0]!.trigger('click');
    await flushPromises();
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(pmUndoDepth(editor.state)).toBe(undoBefore);
    expect(w.emitted('change')).toBeUndefined();
    expect(w.findAll('[data-test="item"]')).toHaveLength(1);
    expect(suggesters()).toHaveLength(1);
    expect(hidden()).toHaveLength(1);
    expect(w.find('.tiptap .suggestion-filter-hidden-insert').exists()).toBe(true);

    await w.find('[data-test="view-all"]').trigger('click');
    await flushPromises();
    expect(suggesters()).toHaveLength(2);
    expect(hidden()).toHaveLength(0);
    w.unmount();
  });

  it('Previous/Next and Accept all skip filtered-out authors (#50)', async () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              marks: [
                {
                  type: 'suggestion_insert',
                  attrs: { id: 's1', author: 'agent:a', ts: 't' },
                },
              ],
              text: 'first',
            },
            { type: 'text', text: ' ' },
            {
              type: 'text',
              marks: [
                {
                  type: 'suggestion_insert',
                  attrs: { id: 's2', author: 'agent:b', ts: 't' },
                },
              ],
              text: 'second',
            },
          ],
        },
      ],
    };
    const w = mount(ManuscriptEditor, { props: { content: doc }, attachTo: document.body });
    await flushPromises();
    expect(w.find('[data-test="counter"]').text()).toBe('1 of 2');

    await w.findAll('[data-test="view-author"]')[1]!.trigger('click');
    await flushPromises();
    expect(w.find('[data-test="counter"]').text()).toBe('1 of 1');
    expect(w.findAll('[data-test="item"]')[0]!.text()).toContain('second');

    await w.find('[data-test="next"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="counter"]').text()).toBe('1 of 1');
    await w.find('[data-test="prev"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="counter"]').text()).toBe('1 of 1');
    w.unmount();
  });

  it('view switcher counter follows single-select author view (#177)', async () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              marks: [
                {
                  type: 'suggestion_insert',
                  attrs: { id: 's1', author: 'agent:a', ts: 't' },
                },
              ],
              text: 'one',
            },
            { type: 'text', text: ' ' },
            {
              type: 'text',
              marks: [
                {
                  type: 'suggestion_insert',
                  attrs: { id: 's2', author: 'agent:b', ts: 't' },
                },
              ],
              text: 'two',
            },
            { type: 'text', text: ' ' },
            {
              type: 'text',
              marks: [
                {
                  type: 'suggestion_insert',
                  attrs: { id: 's3', author: 'agent:a', ts: 't' },
                },
              ],
              text: 'three',
            },
          ],
        },
      ],
    };
    const w = mount(ManuscriptEditor, { props: { content: doc }, attachTo: document.body });
    await flushPromises();
    expect(w.find('[data-test="counter"]').text()).toBe('1 of 3');
    await w.findAll('[data-test="view-author"]')[0]!.trigger('click');
    await flushPromises();
    expect(w.find('[data-test="counter"]').text()).toBe('1 of 2');
    w.unmount();
  });

  it('cycles author views with Alt+[ / Alt+] and announces scope (#177)', async () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              marks: [
                { type: 'suggestion_insert', attrs: { id: 's1', author: 'agent:a', ts: 't' } },
              ],
              text: 'one',
            },
            { type: 'text', text: ' ' },
            {
              type: 'text',
              marks: [
                { type: 'suggestion_insert', attrs: { id: 's2', author: 'agent:b', ts: 't' } },
              ],
              text: 'two',
            },
          ],
        },
      ],
    };
    const w = mount(ManuscriptEditor, { props: { content: doc }, attachTo: document.body });
    await flushPromises();
    await w.find('.manuscript-editor').trigger('keydown', { key: ']', altKey: true });
    await flushPromises();
    expect(w.find('[data-test="view-scope-live"]').text()).toMatch(/Showing 1 change from/);
    await w.find('.manuscript-editor').trigger('keydown', { key: ']', altKey: true });
    await flushPromises();
    expect(w.find('[data-test="view-scope-live"]').text()).toMatch(/1 change from/);
    w.unmount();
  });
});
