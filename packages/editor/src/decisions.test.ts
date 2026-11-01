import { describe, expect, it, vi } from 'vitest';
import type { DocNode, Mark } from '@swarmdraft/schema';
import {
  decideSuggestions,
  listSuggestions,
  parseDecisionRecord,
  parseDecisionRecords,
  withOutdatedFlags,
  runDismissOutdated,
  runDecision,
  selectTargets,
  type DecisionOp,
  type SuggestionKind,
} from './decisions';
import { createReviewPort } from './trusted';

const ins = (id: string, author: string): Mark => ({
  type: 'suggestion_insert',
  attrs: { id, author, ts: '2026-10-25T00:00:00Z' },
});
const del = (id: string, author: string): Mark => ({
  type: 'suggestion_delete',
  attrs: { id, author, ts: '2026-10-25T00:00:00Z' },
});
type Para = Extract<DocNode['content'][number], { type: 'paragraph' }>;
const para = (...content: { text: string; marks?: Mark[] }[]): Para => ({
  type: 'paragraph',
  attrs: { style: 'body' },
  content: content.map((c) => ({ type: 'text' as const, ...c })),
});
const textOf = (d: DocNode) =>
  d.content.map((b) =>
    ('content' in b ? (b.content ?? []) : []).map((n) => ('text' in n ? n.text : '')).join(''),
  );
const t = (kind: SuggestionKind, id: string) => ({ kind, id });
const I = 'suggestion_insert' as const;
const D = 'suggestion_delete' as const;
const F = 'format_change' as const;
const fmt = (id: string, author: string, target: string, before: string, after: string): Mark => ({
  type: 'format_change',
  attrs: { id, author, ts: '2026-10-25T00:00:00Z', target, before, after },
});
const op = (
  decision: 'accept' | 'reject',
  ...targets: { kind: SuggestionKind; id: string }[]
): DecisionOp => ({
  targets,
  decision,
});

// Synthetic text only.
const doc: DocNode = {
  type: 'doc',
  content: [
    para(
      { text: 'The lamp ' },
      { text: 'flickered', marks: [ins('s1', 'Bot A')] },
      { text: ' glowed', marks: [del('s2', 'Bot B')] },
      { text: '.' },
    ),
    para({ text: 'Rain ' }, { text: 'fell', marks: [ins('s3', 'Bot A')] }),
  ],
};

describe('parseDecisionRecords (#51)', () => {
  it('parses valid rows and rejects junk', () => {
    const row = {
      kind: 'suggestion_insert',
      id: 's1',
      status: 'accepted',
      decidedAt: '2026-10-26T03:00:00.000Z',
      decidedBy: 'human:me',
    };
    expect(parseDecisionRecord(row)).toEqual(row);
    expect(parseDecisionRecord({ ...row, status: 'maybe' })).toBeNull();
    expect(parseDecisionRecords([row, null, { ...row, id: 's2' }])).toHaveLength(2);
  });
});

describe('listSuggestions / selectTargets', () => {
  it('lists suggestions with authors, ids from attrs', () => {
    expect(listSuggestions(doc).map((i) => [i.id, i.kind, i.author, i.text])).toEqual([
      ['s1', I, 'Bot A', 'flickered'],
      ['s2', D, 'Bot B', ' glowed'],
      ['s3', I, 'Bot A', 'fell'],
    ]);
  });

  it('includes suggestions inside footnote content', () => {
    const withNote: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { style: 'body' },
          content: [
            { type: 'text', text: 'See' },
            {
              type: 'footnote',
              attrs: {
                id: 'f1',
                kind: 'footnote',
                text: 'a note',
                content: [para({ text: 'a ' }, { text: 'note', marks: [ins('n1', 'Bot C')] })],
              },
            },
          ],
        },
      ],
    };
    expect(listSuggestions(withNote)).toMatchObject([{ id: 'n1', text: 'note' }]);
    const r = decideSuggestions(withNote, op('reject', t(I, 'n1')));
    expect(JSON.stringify(r.doc)).not.toContain('n1');
    const note = (r.doc.content[0] as Para).content![1] as Extract<
      NonNullable<Para['content']>[number],
      { type: 'footnote' }
    >;
    expect(note.attrs.text).toBe('a');
    const accepted = decideSuggestions(withNote, op('accept', t(I, 'n1'))).doc;
    expect(JSON.stringify(accepted)).toContain('"text":"a note"');
    expect(r.decided).toEqual([t(I, 'n1')]);
  });
  it('selects one by (kind,id), by author, all', () => {
    const same: DocNode = {
      type: 'doc',
      content: [
        para({ text: 'x', marks: [ins('dup', 'A')] }, { text: 'y', marks: [del('dup', 'A')] }),
      ],
    };
    expect(selectTargets(listSuggestions(same), { kind: 'one', id: 'dup', suggestion: D })).toEqual(
      [t(D, 'dup')],
    );
    const items = listSuggestions(doc);
    expect(selectTargets(items, { kind: 'one', id: 'nope', suggestion: I })).toEqual([]);
    expect(selectTargets(items, { kind: 'author', author: 'Bot A' })).toEqual([
      t(I, 's1'),
      t(I, 's3'),
    ]);
    expect(selectTargets(items, { kind: 'all' })).toHaveLength(3);
  });
});

describe('decideSuggestions (reference model)', () => {
  it('accept keeps inserts and drops deletes, merging text', () => {
    const r = decideSuggestions(doc, op('accept', t(I, 's1'), t(D, 's2'), t(I, 's3')));
    expect(textOf(r.doc)).toEqual(['The lamp flickered.', 'Rain fell']);
    expect(r.doc.content[0]).toMatchObject({ content: [{ text: 'The lamp flickered.' }] });
  });
  it('reject drops inserts and keeps deleted text', () => {
    const r = decideSuggestions(doc, op('reject', t(I, 's1'), t(D, 's2'), t(I, 's3')));
    expect(textOf(r.doc)).toEqual(['The lamp  glowed.', 'Rain ']);
  });
  it('only touches targets and does not mutate input', () => {
    const snapshot = JSON.stringify(doc);
    const r = decideSuggestions(doc, op('reject', t(D, 's2')));
    expect(listSuggestions(r.doc).map((i) => i.id)).toEqual(['s1', 's3']);
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
  it('overlapping suggestions from two agents on the same range', () => {
    const overlap: DocNode = {
      type: 'doc',
      content: [
        para(
          { text: 'a ' },
          { text: 'bright', marks: [ins('x1', 'Bot A'), del('y1', 'Bot B')] },
          { text: ' day', marks: [del('y1', 'Bot B')] },
        ),
      ],
    };
    let r = decideSuggestions(overlap, op('reject', t(I, 'x1')));
    expect(textOf(r.doc)).toEqual(['a  day']);
    expect(r.outdated).toEqual([]);
    expect(r.superseded).toEqual([]);
    r = decideSuggestions(overlap, op('accept', t(D, 'y1')));
    expect(textOf(r.doc)).toEqual(['a ']);
    expect(r.outdated).toEqual([t(I, 'x1')]);
    expect(r.superseded).toEqual([]);
  });
  it('accept re-anchors non-overlapping pending suggestions', () => {
    const adjoin: DocNode = {
      type: 'doc',
      content: [
        para(
          { text: 'Say ' },
          { text: 'hello', marks: [ins('a1', 'Bot A')] },
          { text: ' to ' },
          { text: 'world', marks: [ins('b1', 'Bot B')] },
        ),
      ],
    };
    const r = decideSuggestions(adjoin, op('accept', t(I, 'a1')));
    expect(listSuggestions(r.doc).map((i) => i.id)).toEqual(['b1']);
    expect(r.outdated).toEqual([]);
  });
  it('is order independent for disjoint suggestions (converges)', () => {
    const a = decideSuggestions(
      decideSuggestions(doc, op('accept', t(I, 's1'))).doc,
      op('reject', t(D, 's2')),
    );
    const b = decideSuggestions(
      decideSuggestions(doc, op('reject', t(D, 's2'))).doc,
      op('accept', t(I, 's1')),
    );
    expect(a.doc).toEqual(b.doc);
  });

  it('accept format_change keeps inline marks; reject restores before', () => {
    const styled: DocNode = {
      type: 'doc',
      content: [
        para({
          text: 'word',
          marks: [fmt('f1', 'Kim', 'bold', '0', '1'), { type: 'bold' }],
        }),
      ],
    };
    let r = decideSuggestions(styled, op('accept', t(F, 'f1')));
    expect(listSuggestions(r.doc)).toHaveLength(0);
    expect(r.doc.content[0]).toMatchObject({
      content: [{ text: 'word', marks: [{ type: 'bold' }] }],
    });
    r = decideSuggestions(styled, op('reject', t(F, 'f1')));
    expect(r.doc.content[0]).toMatchObject({ content: [{ text: 'word' }] });
  });

  it('reject format_change restores paragraph style', () => {
    const docStyle: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { style: 'centered' },
          content: [
            {
              type: 'text',
              text: 'Line',
              marks: [fmt('p1', 'Kim', 'paragraph_style', 'body', 'centered')],
            },
          ],
        },
      ],
    };
    const r = decideSuggestions(docStyle, op('reject', t(F, 'p1')));
    expect(r.doc.content[0]).toMatchObject({ attrs: { style: 'body' } });
    expect(listSuggestions(r.doc)).toHaveLength(0);
  });
});

describe('trusted port + runDecision', () => {
  it('re-finds targets on the live doc so a concurrent edit outside the suggestion survives', async () => {
    let live: DocNode = structuredClone(doc);
    const port = createReviewPort({ read: () => live, commit: (n) => (live = n) });
    const items = listSuggestions(doc); // panel snapshot, now stale
    // Concurrent edit elsewhere (another client / the user typing) before the click lands.
    live = { ...live, content: [...live.content, para({ text: 'A new line.' })] };
    (live.content[1] as Para).content![0] = { type: 'text', text: 'Cold rain ' };
    await runDecision(items, { kind: 'one', id: 's1', suggestion: I }, 'accept', {
      tx: port,
      sink: { recordDecisions: () => {} },
      decidedBy: 'h',
    });
    expect(textOf(live)).toEqual(['The lamp flickered glowed.', 'Cold rain fell', 'A new line.']);
  });
  it('records status, decided_at, decided_by from what the port decided', async () => {
    const tx = {
      applyReviewDecision: vi.fn(() => ({
        decided: [t(I, 's1'), t(I, 's3')],
        outdated: [],
        superseded: [],
      })),
    };
    const sink = { recordDecisions: vi.fn() };
    const now = () => new Date('2026-10-26T03:00:00Z');
    const out = await runDecision(
      listSuggestions(doc),
      { kind: 'author', author: 'Bot A' },
      'accept',
      { tx, sink, decidedBy: 'human:me', now },
    );
    expect(tx.applyReviewDecision).toHaveBeenCalledWith(op('accept', t(I, 's1'), t(I, 's3')));
    expect(sink.recordDecisions).toHaveBeenCalledWith([
      {
        kind: I,
        id: 's1',
        status: 'accepted',
        decidedAt: '2026-10-26T03:00:00.000Z',
        decidedBy: 'human:me',
      },
      {
        kind: I,
        id: 's3',
        status: 'accepted',
        decidedAt: '2026-10-26T03:00:00.000Z',
        decidedBy: 'human:me',
      },
    ]);
    expect(out.unrecorded).toEqual([]);
  });
  it('hands failed sink writes to reconcile', async () => {
    const tx = {
      applyReviewDecision: vi.fn(() => ({
        decided: [t(D, 's2')],
        outdated: [],
        superseded: [],
      })),
    };
    const sink = { recordDecisions: vi.fn(() => Promise.reject(new Error('db locked'))) };
    const reconcile = vi.fn();
    const out = await runDecision(listSuggestions(doc), { kind: 'all' }, 'reject', {
      tx,
      sink,
      reconcile,
      decidedBy: 'h',
    });
    expect(reconcile).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 's2', status: 'rejected' })],
      expect.any(Error),
    );
    expect(out.unrecorded).toHaveLength(1);
  });
  it('does nothing when nothing matches', async () => {
    const tx = { applyReviewDecision: vi.fn() };
    await runDecision(listSuggestions(doc), { kind: 'one', id: 'zz', suggestion: I }, 'reject', {
      tx,
      sink: { recordDecisions: vi.fn() },
      decidedBy: 'h',
    });
    expect(tx.applyReviewDecision).not.toHaveBeenCalled();
  });
});

describe('outdated + dismiss (#178)', () => {
  it('tags items with outdated flags from the index', () => {
    const items = listSuggestions(doc);
    const tagged = withOutdatedFlags(items, new Set(['s2']));
    expect(tagged.find((i) => i.id === 's2')?.outdated).toBe(true);
    expect(tagged.find((i) => i.id === 's1')?.outdated).toBeUndefined();
  });

  it('marks outdated via sink on accept, not as rejected', async () => {
    const tx = {
      applyReviewDecision: vi.fn(() => ({
        decided: [t(D, 'y1')],
        outdated: [t(I, 'x1')],
        superseded: [],
      })),
    };
    const sink = { recordDecisions: vi.fn(), markOutdated: vi.fn() };
    const overlap: DocNode = {
      type: 'doc',
      content: [
        para(
          { text: 'a ' },
          { text: 'bright', marks: [ins('x1', 'Bot A'), del('y1', 'Bot B')] },
          { text: ' day', marks: [del('y1', 'Bot B')] },
        ),
      ],
    };
    const items = listSuggestions(overlap);
    await runDecision(items, { kind: 'one', id: 'y1', suggestion: D }, 'accept', {
      tx,
      sink,
      decidedBy: 'human:me',
    });
    expect(sink.markOutdated).toHaveBeenCalledWith([
      expect.objectContaining({ kind: I, id: 'x1', markedBy: 'human:me' }),
    ]);
    expect(sink.recordDecisions).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'y1', status: 'accepted' }),
    ]);
  });

  it('runDismissOutdated clears marks and calls dismissOutdated', async () => {
    const overlap: DocNode = {
      type: 'doc',
      content: [
        para(
          { text: 'a ' },
          { text: 'bright', marks: [ins('x1', 'Bot A'), del('y1', 'Bot B')] },
          { text: ' day', marks: [del('y1', 'Bot B')] },
        ),
      ],
    };
    const afterAccept = decideSuggestions(overlap, op('accept', t(D, 'y1'))).doc;
    let live = afterAccept;
    const dismiss = vi.fn();
    await runDismissOutdated(afterAccept, [t(I, 'x1')], {
      store: { read: () => live, commit: (n) => (live = n) },
      sink: { recordDecisions: () => {}, dismissOutdated: dismiss },
      dismissedBy: 'human:me',
    });
    expect(dismiss).toHaveBeenCalledWith([t(I, 'x1')]);
  });
});
