import { afterEach, describe, expect, it } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import * as Y from 'yjs';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { docToYDoc } from '@coauthor/docx';
import { collaborativeEditorOptions, collectReviewItems } from './index';
import { allowReviewEdits } from './trusted';

// Synthetic sample text only.
//
// Regression for remote review changes: before #16 the guard refused the y-sync binding's
// render of a peer's accept/reject or new suggestion, leaving B's view stale. Remote renders
// now pass only when the binding itself dispatched the transaction (module-private WeakSet in
// ./ysource); a forged y-sync meta does not.
const by = { author: 'agent:sample', ts: '2026-10-25T00:00:00Z' };
const ins = (id: string) => ({ type: 'suggestion_insert', attrs: { id, ...by } });
const del = (id: string) => ({ type: 'suggestion_delete', attrs: { id, ...by } });
const p = (c: JSONContent[]): JSONContent => ({
  type: 'paragraph',
  attrs: { style: 'body' },
  content: c,
});
const DOC: JSONContent = {
  type: 'doc',
  content: [
    p([{ type: 'text', text: 'Alpha line.' }]),
    p([
      { type: 'text', text: 'The ' },
      { type: 'text', marks: [del('s1')], text: 'grey' },
      { type: 'text', marks: [ins('s1')], text: 'silver' },
      { type: 'text', text: ' kettle sang.' },
    ]),
  ],
};
const txt = (e: Editor) => e.state.doc.textBetween(0, e.state.doc.content.size, '|');
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Decide suggestion `id` on `e` the way the trusted review port does (by attrs.id). */
function decide(e: Editor, id: string, decision: 'accept' | 'reject', trusted = true): void {
  const tr = e.state.tr;
  const cuts: [number, number][] = [];
  e.state.doc.descendants((n, pos) => {
    if (!n.isText) return true;
    for (const m of n.marks) {
      if (m.attrs.id !== id || !m.type.name.startsWith('suggestion_')) continue;
      const drop = (m.type.name === 'suggestion_insert') !== (decision === 'accept');
      if (drop) cuts.push([pos, pos + n.nodeSize]);
      else tr.removeMark(pos, pos + n.nodeSize, m);
    }
    return false;
  });
  for (const [f, t] of cuts.reverse()) tr.delete(tr.mapping.map(f), tr.mapping.map(t));
  e.view.dispatch(trusted ? allowReviewEdits(tr) : tr);
}

const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((e) => e.destroy()));

async function pair() {
  const a = docToYDoc(structuredClone(DOC) as never);
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const qa: Uint8Array[] = [];
  const qb: Uint8Array[] = [];
  a.on('update', (u: Uint8Array, o: unknown) => o !== 'remote' && qa.push(u));
  b.on('update', (u: Uint8Array, o: unknown) => o !== 'remote' && qb.push(u));
  const mk = (d: Y.Doc) =>
    new Editor(collaborativeEditorOptions(d, { element: document.createElement('div') }));
  const ea = mk(a);
  const eb = mk(b);
  editors.push(ea, eb);
  await tick();
  const flush = async () => {
    qa.splice(0).forEach((u) => Y.applyUpdate(b, u, 'remote'));
    qb.splice(0).forEach((u) => Y.applyUpdate(a, u, 'remote'));
    await tick();
  };
  return { a, b, ea, eb, flush };
}

describe('remote Yjs sync through the review guard', () => {
  it('an accept on A shows up in B', async () => {
    const { ea, eb, flush } = await pair();
    decide(ea, 's1', 'accept');
    await flush();
    expect(txt(ea)).toBe('Alpha line.|The silver kettle sang.');
    expect(txt(eb)).toBe('Alpha line.|The silver kettle sang.');
    expect(collectReviewItems(eb.state.doc)).toEqual([]);
  });

  it('a reject on A shows up in B', async () => {
    const { eb, ea, flush } = await pair();
    decide(ea, 's1', 'reject');
    await flush();
    expect(txt(eb)).toBe('Alpha line.|The grey kettle sang.');
  });

  it('a new suggestion written on A appears in B', async () => {
    const { ea, eb, flush } = await pair();
    const tr = ea.state.tr.insert(
      ea.state.doc.content.size - 1,
      ea.schema.text(' Again.', [ea.schema.marks.suggestion_insert!.create({ id: 's9', ...by })]),
    );
    ea.view.dispatch(allowReviewEdits(tr));
    await flush();
    expect(txt(eb)).toBe('Alpha line.|The greysilver kettle sang. Again.');
    expect(collectReviewItems(eb.state.doc).map((i) => i.id)).toContain('s9');
  });

  it('a local untrusted mark change is still refused, even with a forged y-sync meta', async () => {
    const { ea } = await pair();
    const before = txt(ea);
    decide(ea, 's1', 'reject', false);
    expect(txt(ea)).toBe(before);
    const tr = ea.state.tr.setMeta(ySyncPluginKey, { isChangeOrigin: true });
    ea.state.doc.descendants((n, pos) => {
      for (const m of n.marks) if (m.attrs.id === 's1') tr.removeMark(pos, pos + n.nodeSize, m);
    });
    ea.view.dispatch(tr);
    expect(collectReviewItems(ea.state.doc).map((i) => i.id)).toEqual(['s1', 's1']);
  });

  it('undo after an accept restores the suggestion everywhere; redo reapplies it', async () => {
    const { ea, eb, flush } = await pair();
    decide(ea, 's1', 'accept');
    await flush();
    expect(ea.commands.undo()).toBe(true);
    await flush();
    expect(txt(ea)).toBe('Alpha line.|The greysilver kettle sang.');
    expect(txt(eb)).toBe('Alpha line.|The greysilver kettle sang.');
    expect(collectReviewItems(ea.state.doc).map((i) => i.type)).toEqual([
      'suggestion_delete',
      'suggestion_insert',
    ]);
    expect(ea.commands.redo()).toBe(true);
    await flush();
    expect(txt(ea)).toBe('Alpha line.|The silver kettle sang.');
    expect(txt(eb)).toBe('Alpha line.|The silver kettle sang.');
  });
});
