import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { undoDepth } from '@tiptap/pm/history';
import { docToYDoc } from '@coauthor/docx';
import { collaborativeEditorOptions } from './collab';
import {
  FindHighlight,
  listFindMatches,
  replaceFindMatches,
  updateFindHighlight,
} from './find-replace';

function boundEditor(content: unknown) {
  const ydoc = docToYDoc(content as never);
  return new Editor({
    ...collaborativeEditorOptions(ydoc, { extensions: [FindHighlight] }),
    element: document.createElement('div'),
  });
}

describe('find-replace', () => {
  it('lists matches per text block with match case and whole word', () => {
    const e = boundEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'The the end.' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Another the.' }],
        },
      ],
    });
    const doc = e.state.doc;
    expect(listFindMatches(doc, 'the', { matchCase: false, wholeWord: false })).toHaveLength(4);
    expect(listFindMatches(doc, 'the', { matchCase: true, wholeWord: false })).toHaveLength(3);
    expect(listFindMatches(doc, 'the', { matchCase: false, wholeWord: true })).toHaveLength(3);
    e.destroy();
  });

  it('finds a phrase split across formatting marks in one paragraph', () => {
    const e = boundEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'the ' },
            { type: 'text', text: 'great', marks: [{ type: 'italic' }] },
            { type: 'text', text: ' war' },
          ],
        },
      ],
    });
    expect(
      listFindMatches(e.state.doc, 'great war', { matchCase: false, wholeWord: false }),
    ).toHaveLength(1);
    e.destroy();
  });

  it('whole word does not match inside a longer word split by formatting', () => {
    const e = boundEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'un' },
            { type: 'text', text: 'happy', marks: [{ type: 'italic' }] },
          ],
        },
      ],
    });
    expect(
      listFindMatches(e.state.doc, 'happy', { matchCase: false, wholeWord: true }),
    ).toHaveLength(0);
    e.destroy();
  });

  it('does not match across a suggestion between two plain runs', () => {
    const e = boundEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'test' },
            {
              type: 'text',
              text: 'X',
              marks: [
                {
                  type: 'suggestion_insert',
                  attrs: { id: 's1', author: 'a1', ts: '2026-10-25T00:00:00Z' },
                },
              ],
            },
            { type: 'text', text: 'test' },
          ],
        },
      ],
    });
    expect(
      listFindMatches(e.state.doc, 'sttest', { matchCase: false, wholeWord: false }),
    ).toHaveLength(0);
    e.destroy();
  });

  it('skips text inside suggestion marks', () => {
    const e = boundEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'plain ' },
            {
              type: 'text',
              text: 'hidden',
              marks: [
                {
                  type: 'suggestion_insert',
                  attrs: { id: 's1', author: 'a1', ts: '2026-10-25T00:00:00Z' },
                },
              ],
            },
            { type: 'text', text: ' plain' },
          ],
        },
      ],
    });
    expect(
      listFindMatches(e.state.doc, 'plain', { matchCase: false, wholeWord: false }),
    ).toHaveLength(2);
    expect(
      listFindMatches(e.state.doc, 'hidden', { matchCase: false, wholeWord: false }),
    ).toHaveLength(0);
    e.destroy();
  });

  it('replace one and replace all each use one undo step', async () => {
    const e = boundEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'foo foo foo' }],
        },
      ],
    });
    await new Promise((r) => setTimeout(r, 0));
    const before = e.getText();
    replaceFindMatches(e, 'foo', 'bar', { matchCase: false, wholeWord: false }, 'one', 0);
    await new Promise((r) => setTimeout(r, 0));
    expect(e.getText()).toBe('bar foo foo');
    expect(e.commands.undo()).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(e.getText()).toBe(before);

    replaceFindMatches(e, 'foo', 'bar', { matchCase: false, wholeWord: false }, 'all', 0);
    await new Promise((r) => setTimeout(r, 0));
    expect(e.getText()).toBe('bar bar bar');
    expect(e.commands.undo()).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(e.getText()).toBe(before);
    e.destroy();
  });

  it('updateFindHighlight does not add an undo step', async () => {
    const e = boundEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'abc' }] }],
    });
    await new Promise((r) => setTimeout(r, 0));
    const depth = undoDepth(e.state);
    const matches = listFindMatches(e.state.doc, 'a', { matchCase: false, wholeWord: false });
    updateFindHighlight(e, matches, 0);
    expect(undoDepth(e.state)).toBe(depth);
    e.destroy();
  });
});
