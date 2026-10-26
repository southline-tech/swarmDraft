import { describe, expect, it, vi } from 'vitest';
import type { DocNode, Mark } from '@coauthor/schema';
import {
  authorColor,
  decideSuggestions,
  listSuggestions,
  runDecision,
  selectSuggestionIds,
} from './decisions';

const ins = (id: string, author: string): Mark => ({
  type: 'suggestion_insert',
  attrs: { id, author, ts: '2026-10-25T00:00:00Z' },
});
const del = (id: string, author: string): Mark => ({
  type: 'suggestion_delete',
  attrs: { id, author, ts: '2026-10-25T00:00:00Z' },
});
const para = (...content: { text: string; marks?: Mark[] }[]): DocNode['content'][number] => ({
  type: 'paragraph',
  attrs: { style: 'body' },
  content: content.map((c) => ({ type: 'text', ...c })),
});
const textOf = (d: DocNode) =>
  d.content.map((b) =>
    ('content' in b ? (b.content ?? []) : []).map((n) => ('text' in n ? n.text : '')).join(''),
  );

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

describe('listSuggestions', () => {
  it('lists suggestions with authors, ids from attrs', () => {
    expect(listSuggestions(doc).map((i) => [i.id, i.kind, i.author, i.text])).toEqual([
      ['s1', 'suggestion_insert', 'Bot A', 'flickered'],
      ['s2', 'suggestion_delete', 'Bot B', ' glowed'],
      ['s3', 'suggestion_insert', 'Bot A', 'fell'],
    ]);
  });
  it('selects one, by author, all', () => {
    const items = listSuggestions(doc);
    expect([...selectSuggestionIds(items, { kind: 'one', id: 's2' })]).toEqual(['s2']);
    expect([...selectSuggestionIds(items, { kind: 'one', id: 'nope' })]).toEqual([]);
    expect([...selectSuggestionIds(items, { kind: 'author', author: 'Bot A' })]).toEqual([
      's1',
      's3',
    ]);
    expect(selectSuggestionIds(items, { kind: 'all' }).size).toBe(3);
  });
});

describe('decideSuggestions', () => {
  it('accept keeps inserts and drops deletes', () => {
    const r = decideSuggestions(doc, new Set(['s1', 's2', 's3']), 'accept');
    expect(textOf(r.doc)).toEqual(['The lamp flickered.', 'Rain fell']);
    expect(listSuggestions(r.doc)).toEqual([]);
    // Adjacent unmarked text is merged back into one node.
    expect(r.doc.content[0]).toMatchObject({ content: [{ text: 'The lamp flickered.' }] });
  });
  it('reject drops inserts and keeps deleted text', () => {
    const r = decideSuggestions(doc, new Set(['s1', 's2', 's3']), 'reject');
    expect(textOf(r.doc)).toEqual(['The lamp  glowed.', 'Rain ']);
  });
  it('only touches selected ids and does not mutate input', () => {
    const snapshot = JSON.stringify(doc);
    const r = decideSuggestions(doc, new Set(['s2']), 'reject');
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
    // Rejecting A's insert removes the text; B's delete survives only on its remaining text.
    let r = decideSuggestions(overlap, new Set(['x1']), 'reject');
    expect(textOf(r.doc)).toEqual(['a  day']);
    expect(r.superseded).toEqual([]);
    expect(listSuggestions(r.doc)).toMatchObject([{ id: 'y1', text: ' day' }]);
    // Accepting B's delete removes the shared range, superseding A's insert entirely.
    r = decideSuggestions(overlap, new Set(['y1']), 'accept');
    expect(textOf(r.doc)).toEqual(['a ']);
    expect(r.superseded).toEqual(['x1']);
    // Accepting A keeps the text but B's delete mark stays on it.
    r = decideSuggestions(overlap, new Set(['x1']), 'accept');
    expect(listSuggestions(r.doc)).toMatchObject([{ id: 'y1', text: 'bright day' }]);
  });
  it('is order independent for disjoint suggestions (converges)', () => {
    const a = decideSuggestions(
      decideSuggestions(doc, new Set(['s1']), 'accept').doc,
      new Set(['s2']),
      'reject',
    );
    const b = decideSuggestions(
      decideSuggestions(doc, new Set(['s2']), 'reject').doc,
      new Set(['s1']),
      'accept',
    );
    expect(a.doc).toEqual(b.doc);
  });
});

describe('runDecision', () => {
  it('applies once and records status, decided_at, decided_by', async () => {
    const tx = { applyReviewDecision: vi.fn() };
    const sink = { recordDecisions: vi.fn() };
    const now = () => new Date('2026-10-26T03:00:00Z');
    await runDecision(doc, { kind: 'author', author: 'Bot A' }, 'accept', {
      tx,
      sink,
      decidedBy: 'human:me',
      now,
    });
    expect(tx.applyReviewDecision).toHaveBeenCalledTimes(1);
    expect(sink.recordDecisions).toHaveBeenCalledWith([
      {
        id: 's1',
        status: 'accepted',
        decidedAt: '2026-10-26T03:00:00.000Z',
        decidedBy: 'human:me',
      },
      {
        id: 's3',
        status: 'accepted',
        decidedAt: '2026-10-26T03:00:00.000Z',
        decidedBy: 'human:me',
      },
    ]);
  });
  it('does nothing when nothing matches', async () => {
    const tx = { applyReviewDecision: vi.fn() };
    await runDecision(doc, { kind: 'one', id: 'zz' }, 'reject', { tx, decidedBy: 'h' });
    expect(tx.applyReviewDecision).not.toHaveBeenCalled();
  });
});

it('authorColor is stable per author', () => {
  expect(authorColor('Bot A')).toBe(authorColor('Bot A'));
  expect(authorColor('Bot A')).not.toBe(authorColor('Bot B'));
});
