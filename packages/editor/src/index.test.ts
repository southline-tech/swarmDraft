import { afterEach, describe, expect, it } from 'vitest';
import type { Editor, JSONContent } from '@tiptap/core';
import {
  BLOCK_NODE_TYPES,
  INLINE_NODE_TYPES,
  MARK_TYPES,
  NON_EXCLUSIVE_MARKS,
} from '@coauthor/schema';
import {
  ALLOW_REVIEW_EDITS,
  REVIEW_MARKS,
  collectReviewItems,
  createManuscriptEditor,
  markKey,
  markTypeFromKey,
} from './index';

// Synthetic sample text only.
const by = { author: 'agent:grok', ts: '2026-10-25T00:00:00Z' };
const SAMPLE: JSONContent = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Chapter One' }] },
    {
      type: 'paragraph',
      attrs: { style: 'first' },
      content: [
        { type: 'text', text: 'The ' },
        { type: 'text', marks: [{ type: 'italic' }], text: 'lantern' },
        { type: 'text', text: ' ' },
        {
          type: 'text',
          marks: [{ type: 'suggestion_delete', attrs: { id: 's1', ...by } }],
          text: 'flickered',
        },
        {
          type: 'text',
          marks: [{ type: 'suggestion_insert', attrs: { id: 's1', ...by } }],
          text: 'guttered',
        },
        { type: 'text', text: ' twice.' },
        { type: 'hard_break' },
        {
          type: 'text',
          marks: [
            { type: 'comment_anchor', attrs: { id: 'c1' } },
            { type: 'comment_anchor', attrs: { id: 'c2' } },
          ],
          text: 'Rain',
        },
        { type: 'text', marks: [{ type: 'comment_anchor', attrs: { id: 'c2' } }], text: ' fell.' },
      ],
    },
    { type: 'scene_break', attrs: { marker: '***' } },
    {
      type: 'paragraph',
      attrs: { style: 'block_quote' },
      content: [
        { type: 'text', marks: [{ type: 'bold' }, { type: 'smallcaps' }], text: 'Morning' },
        { type: 'text', text: ' came ' },
        {
          type: 'text',
          marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
          text: 'late',
        },
        { type: 'text', marks: [{ type: 'underline' }, { type: 'strike' }], text: '.' },
      ],
    },
    { type: 'page_break' },
    { type: 'paragraph', attrs: { style: 'centered' }, content: [{ type: 'text', text: 'End' }] },
  ],
};

let editor: Editor;
const make = (content: JSONContent = SAMPLE) => (editor = createManuscriptEditor({ content }));
afterEach(() => editor?.destroy());

/** Position of the first character of `text` in the document. */
function posOf(text: string): number {
  let found = -1;
  editor.state.doc.descendants((n, pos) => {
    if (found < 0 && n.isText && n.text?.includes(text)) found = pos + n.text.indexOf(text);
  });
  if (found < 0) throw new Error(`not found: ${text}`);
  return found;
}

describe('manuscript schema', () => {
  it('round-trips JSON exactly', () => {
    make();
    expect(editor.getJSON()).toEqual(SAMPLE);
  });

  it('round-trips through HTML', () => {
    make();
    const html = editor.getHTML();
    expect(html).toContain('<del');
    expect(html).toContain('<ins');
    const again = createManuscriptEditor({ content: html });
    expect(again.getJSON()).toEqual(SAMPLE);
    again.destroy();
  });

  it('only knows the manuscript nodes and marks', () => {
    make();
    expect(Object.keys(editor.schema.nodes).sort()).toEqual(
      ['doc', ...BLOCK_NODE_TYPES, ...INLINE_NODE_TYPES].sort(),
    );
    expect(Object.keys(editor.schema.marks).sort()).toEqual([...MARK_TYPES].sort());
  });

  it('review marks are exactly the schema non-exclusive marks', () => {
    expect([...REVIEW_MARKS].sort()).toEqual([...NON_EXCLUSIVE_MARKS].sort());
  });

  it('keys review marks type--hash(id), parseable by y-prosemirror', () => {
    expect(markKey({ type: 'comment_anchor', attrs: { id: 'c1' } })).toBe(
      'comment_anchor--8829dfd9',
    );
    expect(markKey({ type: 'suggestion_insert', attrs: { id: 's1', ...by } })).toMatch(
      /^suggestion_insert--[0-9a-f]{8}$/,
    );
    expect(markKey({ type: 'italic' })).toBe('italic');
    expect(markKey({ type: 'link', attrs: { href: 'x' } })).toBe('link');
    expect(markTypeFromKey('comment_anchor--c1')).toBe('comment_anchor');
    expect(markTypeFromKey('bold')).toBe('bold');
  });
});

describe('drafting', () => {
  const plain: JSONContent = {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { style: 'body' }, content: [{ type: 'text', text: 'Night' }] },
    ],
  };

  it('toggles bold and italic with keyboard shortcuts', () => {
    make(plain);
    editor.commands.selectAll();
    editor.commands.keyboardShortcut('Mod-b');
    editor.commands.keyboardShortcut('Mod-i');
    const marks = editor.getJSON().content?.[0]?.content?.[0]?.marks?.map((m) => m.type);
    expect(marks?.sort()).toEqual(['bold', 'italic']);
  });

  it('turns *** on its own line into a scene break', async () => {
    make({ type: 'doc', content: [{ type: 'paragraph', attrs: { style: 'body' } }] });
    editor.view.dispatch(editor.state.tr.insertText('**'));
    // Input rules for simulated input run on the next tick.
    editor.commands.insertContent({ type: 'text', text: '*' }, { applyInputRules: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(editor.getJSON().content?.map((n) => n.type)).toEqual(['scene_break', 'paragraph']);
    expect(editor.getJSON().content?.[1]?.attrs?.style).toBe('first');
  });

  it('does not convert *** inside other text', async () => {
    make(plain);
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.view.dispatch(editor.state.tr.insertText('**'));
    editor.commands.insertContent({ type: 'text', text: '*' }, { applyInputRules: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(editor.getJSON().content?.map((n) => n.type)).toEqual(['paragraph']);
    expect(editor.state.doc.textContent).toBe('Night***');
  });

  it('sets paragraph styles and rejects unknown ones', () => {
    make(plain);
    expect(editor.commands.setParagraphStyle('verse')).toBe(true);
    expect(editor.getJSON().content?.[0]?.attrs?.style).toBe('verse');
    expect(editor.commands.setParagraphStyle('nope' as never)).toBe(false);
  });
});

describe('review marks are read-only', () => {
  const text = () => editor.state.doc.textContent;

  it('allows normal editing outside suggestions', () => {
    make();
    editor.commands.insertContentAt(posOf(' twice.') + ' twice'.length, ' or thrice');
    expect(text()).toContain('twice or thrice.');
  });

  it('refuses typing inside a suggestion', () => {
    make();
    editor.commands.insertContentAt(posOf('flickered') + 3, 'X');
    editor.commands.insertContentAt(posOf('guttered') + 3, 'X');
    expect(text()).toContain('flickeredguttered');
  });

  it('refuses deleting text that carries a suggestion', () => {
    make();
    const from = posOf('lantern');
    editor.commands.deleteRange({ from, to: posOf(' twice.') });
    expect(text()).toContain('lantern flickeredguttered twice.');
  });

  it('refuses adding or removing review marks', () => {
    make();
    const from = posOf('Morning');
    editor.commands.setTextSelection({ from, to: from + 7 });
    editor.commands.setMark('comment_anchor', { id: 'new' });
    editor.commands.setMark('suggestion_insert', { id: 's9', ...by });
    expect(collectReviewItems(editor.state.doc).map((r) => r.id)).toEqual(['s1', 's1', 'c1', 'c2']);
    editor.commands.setTextSelection({ from: posOf('Rain'), to: posOf(' fell.') + 6 });
    editor.commands.unsetMark('comment_anchor');
    expect(editor.getJSON()).toEqual(SAMPLE);
  });

  it('still allows formatting and paragraph style around review marks', () => {
    make();
    editor.commands.setTextSelection(posOf('twice'));
    expect(editor.commands.setParagraphStyle('body')).toBe(true);
    expect(editor.getJSON().content?.[1]?.attrs?.style).toBe('body');
  });

  it('lets trusted code change them with the allow meta', () => {
    make();
    const from = posOf('Morning');
    const type = editor.schema.marks.comment_anchor!;
    editor.view.dispatch(
      editor.state.tr
        .addMark(from, from + 7, type.create({ id: 'c3' }))
        .setMeta(ALLOW_REVIEW_EDITS, true),
    );
    expect(collectReviewItems(editor.state.doc).some((r) => r.id === 'c3')).toBe(true);
  });

  it('lists comments and suggestions in reading order', () => {
    make();
    expect(collectReviewItems(editor.state.doc)).toEqual([
      { type: 'suggestion_delete', id: 's1', ...by, text: 'flickered' },
      { type: 'suggestion_insert', id: 's1', ...by, text: 'guttered' },
      { type: 'comment_anchor', id: 'c1', text: 'Rain' },
      { type: 'comment_anchor', id: 'c2', text: 'Rain fell.' },
    ]);
  });
});
