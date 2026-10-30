import { describe, expect, it } from 'vitest';
import type { DecisionRecord } from '@coauthor/editor';
import { mergeLoadedDecisionRecords } from './decision-records-load';

const row = (id: string): DecisionRecord => ({
  kind: 'suggestion_insert',
  id,
  status: 'accepted',
  decidedAt: 't',
  decidedBy: 'author',
});

describe('mergeLoadedDecisionRecords (#51 load race)', () => {
  it('uses incoming when the log did not change during load', () => {
    const incoming = { s1: [row('a')] };
    expect(mergeLoadedDecisionRecords({}, incoming, {})).toEqual(incoming);
  });

  it('keeps in-flight accept when stale load resolves empty', () => {
    const local = { s1: [row('fresh')] };
    expect(mergeLoadedDecisionRecords({}, {}, local)).toEqual(local);
  });

  it('merges per section: unchanged sections hydrate from storage', () => {
    const atStart = { s1: [row('old')] };
    const incoming = { s1: [row('stored')], s2: [row('b')] };
    const current = { s1: [row('accepted-in-flight')] };
    expect(mergeLoadedDecisionRecords(atStart, incoming, current)).toEqual({
      s1: [row('accepted-in-flight')],
      s2: [row('b')],
    });
  });
});
