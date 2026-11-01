/**
 * Cross-language round trip for the Rust MCP server's Yjs encoding (UTF-16 offsets).
 *
 * sections.json: every non-empty section of the mock .docx plus a synthetic section with curly
 * quotes, an em dash, © and an emoji surrogate pair under marks. ts-updates.json: those sections
 * encoded by docToYDoc. rust-updates.json: the same encoded by content::encode (written by the
 * cargo test `roundtrip_fixture`). This test opens every Rust update in the real editor and
 * expects the original JSON back with no writes; the cargo test decodes the TS updates.
 *
 * Regenerate: UPDATE_FIXTURES=1 pnpm --filter @swarmdraft/editor test, then
 * UPDATE_FIXTURES=1 cargo test roundtrip_fixture (in apps/desktop/src-tauri), then rerun both.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Editor } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { docToYDoc, importDocx } from '@swarmdraft/docx';
import type { DocNode } from '@swarmdraft/schema';
import { checkYDocContent, collaborativeEditorOptions, contentErrorOf } from './index';

// Vitest runs with the package as cwd (happy-dom replaces import.meta.url's scheme).
const ROOT = resolve(process.cwd(), '../..');
const dir = (f: string) => resolve(ROOT, 'fixtures/mcp/roundtrip', f);
const MOCK = resolve(ROOT, 'fixtures/manuscripts/docx-import/mock-manuscript.docx');

const UNICODE: DocNode = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: { style: 'body' },
      content: [
        { type: 'text', text: '“Curly” — dash © ' },
        { type: 'text', text: 'emoji 😀 bold', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' then ' },
        {
          type: 'text',
          text: 'anchored ‘after’ 👩‍💻',
          marks: [
            { type: 'italic' },
            { type: 'comment_anchor', attrs: { id: 'c1' } },
            { type: 'comment_anchor', attrs: { id: 'c2' } },
          ],
        },
        { type: 'text', text: ' tail…' },
      ],
    },
  ],
} as unknown as DocNode;

// Key order and the order of marks on a run don't matter (two comments on one run are a set).
const norm = (x: unknown, key?: string): unknown =>
  Array.isArray(x)
    ? key === 'marks'
      ? x.map((m) => norm(m)).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1))
      : x.map((v) => norm(v))
    : x && typeof x === 'object'
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, norm((x as Record<string, unknown>)[k], k)]),
        )
      : x;

function build(): DocNode[] {
  const m = importDocx(readFileSync(MOCK), { manuscriptId: 'm1' });
  const secs = m.sections.filter((s) => s.content.content.length).map((s) => s.content);
  return [...secs, UNICODE];
}

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

describe('Rust <-> TS Yjs round trip', () => {
  it('fixture sections are current', () => {
    const secs = build();
    if (process.env.UPDATE_FIXTURES) {
      writeFileSync(dir('sections.json'), JSON.stringify(secs) + '\n');
      writeFileSync(
        dir('ts-updates.json'),
        JSON.stringify(secs.map((s) => b64(Y.encodeStateAsUpdate(docToYDoc(s))))) + '\n',
      );
    }
    expect(JSON.parse(readFileSync(dir('sections.json'), 'utf8'))).toEqual(
      JSON.parse(JSON.stringify(secs)),
    );
    expect(secs.length).toBeGreaterThanOrEqual(22);
  });

  it('opens every Rust-encoded section in the editor unchanged', async () => {
    expect(existsSync(dir('rust-updates.json'))).toBe(true);
    const secs = JSON.parse(readFileSync(dir('sections.json'), 'utf8')) as DocNode[];
    const updates = JSON.parse(readFileSync(dir('rust-updates.json'), 'utf8')) as string[];
    expect(updates.length).toBe(secs.length);
    const bad: number[] = [];
    for (let i = 0; i < secs.length; i++) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, Buffer.from(updates[i]!, 'base64'));
      expect(checkYDocContent(doc)).toBeUndefined();
      let writes = 0;
      doc.on('update', () => writes++);
      const ed = new Editor(
        collaborativeEditorOptions(doc, { element: document.createElement('div') }),
      );
      await new Promise((r) => setTimeout(r, 0));
      expect(contentErrorOf(ed)).toBeUndefined();
      if (JSON.stringify(norm(ed.getJSON())) !== JSON.stringify(norm(secs[i]))) bad.push(i);
      expect(writes).toBe(0);
      ed.destroy();
    }
    expect(bad).toEqual([]);
  });
});
