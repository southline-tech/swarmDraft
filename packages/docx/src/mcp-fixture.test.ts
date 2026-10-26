/**
 * Cross-language fixture for the in-app MCP server (RAD-209): a synthetic section encoded with
 * docToYDoc (client id 1, so the update is deterministic), plus its readView and Yjs mark keys.
 * The Rust side (apps/desktop/src-tauri/src/content.rs) decodes the same bytes and must agree.
 * Regenerate with UPDATE_FIXTURES=1 pnpm --filter @coauthor/docx test.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  BLOCK_NODE_TYPES,
  INLINE_NODE_TYPES,
  MARK_TYPES,
  NON_EXCLUSIVE_MARKS,
  type DocNode,
  type Mark,
} from '@coauthor/schema';
import { docToYDoc, markKey, yDocToDoc } from './ydoc';
import { readView } from './model';

const dir = fileURLToPath(new URL('../../../fixtures/mcp/', import.meta.url));

const ins = { id: 's1', author: 'agent:fixture', ts: '2026-01-01T00:00:00Z' };
const del = { id: 's2', author: 'agent:fixture', ts: '2026-01-01T00:00:00Z' };

export const SECTION: DocNode = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Chapter One' }] },
    {
      type: 'paragraph',
      attrs: { style: 'first' },
      content: [
        { type: 'text', text: 'The lamp on the test bench blinked ' },
        { type: 'text', text: 'twice', marks: [{ type: 'italic' }] },
        { type: 'text', text: ', then held ' },
        {
          type: 'text',
          text: 'steady',
          marks: [{ type: 'comment_anchor', attrs: { id: 'c1' } }],
        },
        { type: 'text', text: '.' },
        {
          type: 'footnote',
          attrs: {
            id: '1',
            kind: 'footnote',
            text: 'A placeholder note.',
            content: [
              {
                type: 'paragraph',
                attrs: { style: 'body' },
                content: [{ type: 'text', text: 'A placeholder note.' }],
              },
            ],
          },
        },
      ],
    },
    {
      type: 'paragraph',
      attrs: { style: 'body' },
      content: [
        { type: 'text', text: 'Sample text with a ' },
        { type: 'text', text: 'quick ', marks: [{ type: 'suggestion_delete', attrs: del }] },
        { type: 'text', text: 'brief ', marks: [{ type: 'suggestion_insert', attrs: ins }] },
        { type: 'text', text: 'edit', marks: [{ type: 'bold' }] },
        { type: 'hard_break' },
        { type: 'text', text: 'and a second line.' },
        {
          type: 'footnote',
          attrs: { id: '2', kind: 'endnote', text: 'An endnote.', content: [] },
        },
      ],
    },
    { type: 'scene_break', attrs: { marker: '***' } },
    {
      type: 'paragraph',
      attrs: { style: 'block_quote' },
      content: [
        { type: 'text', text: 'Quoted filler ' },
        { type: 'image', attrs: { alt: 'diagram' } },
      ],
    },
    { type: 'page_break' },
  ],
};

const MARKS: Mark[] = [
  { type: 'italic' },
  { type: 'comment_anchor', attrs: { id: 'c1' } },
  { type: 'suggestion_insert', attrs: ins },
  { type: 'suggestion_delete', attrs: del },
];

function build() {
  const ydoc = new Y.Doc();
  ydoc.clientID = 1;
  docToYDoc(SECTION, ydoc);
  return {
    update: Buffer.from(Y.encodeStateAsUpdate(ydoc)),
    json:
      JSON.stringify(
        {
          doc: yDocToDoc(ydoc),
          readView: readView(SECTION),
          markKeys: MARKS.map((m) => [m, markKey(m)]),
          // The schema's allowed types; the Rust validator asserts it uses the same lists.
          schema: {
            blockNodes: BLOCK_NODE_TYPES,
            inlineNodes: INLINE_NODE_TYPES,
            marks: MARK_TYPES,
            nonExclusiveMarks: NON_EXCLUSIVE_MARKS,
          },
        },
        null,
        2,
      ) + '\n',
  };
}

describe('MCP cross-language fixture', () => {
  it('matches the checked-in Yjs update and read view', () => {
    const { update, json } = build();
    if (process.env.UPDATE_FIXTURES) {
      writeFileSync(dir + 'synthetic-section.yupdate', update);
      writeFileSync(dir + 'synthetic-section.json', json);
    }
    expect(readFileSync(dir + 'synthetic-section.yupdate').equals(update)).toBe(true);
    expect(readFileSync(dir + 'synthetic-section.json', 'utf8')).toBe(json);
  });
});
