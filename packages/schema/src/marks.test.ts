import { describe, expect, it } from 'vitest';
import {
  MARK_ID_HASH_TEST_VECTOR,
  MAX_MARK_KEY_TRIES,
  freeMarkKey,
  isParseableMarkKey,
  markIdHash,
  markKey,
  markKeys,
  markTypeFromKey,
} from './marks';

const A = { type: 'comment_anchor', attrs: { id: 'a' } };
const B = { type: 'comment_anchor', attrs: { id: 'b' } };
// Forced collision: every unsalted id hashes alike; salted inputs fall through to the real hash.
const colliding = (s: string) => (s.includes(':') ? markIdHash(s) : 'AAAAAAAA');

describe('mark keys', () => {
  it('matches the cross-language test vector', () => {
    expect(markIdHash(MARK_ID_HASH_TEST_VECTOR[0])).toBe(MARK_ID_HASH_TEST_VECTOR[1]);
    expect(MARK_ID_HASH_TEST_VECTOR[1]).toBe('fwe1SmhZ');
    expect(markKey({ type: 'comment_anchor', attrs: { id: 'c1' } })).toBe(
      'comment_anchor--fwe1SmhZ',
    );
    expect(isParseableMarkKey(markKey({ type: 'comment_anchor', attrs: { id: 'x/y+z' } }))).toBe(
      true,
    );
  });

  it('keys exclusive marks by type and parses keys back', () => {
    expect(markKey({ type: 'italic' })).toBe('italic');
    expect(markKey({ type: 'link', attrs: { id: 'x', href: 'y' } })).toBe('link');
    expect(markTypeFromKey('comment_anchor--fwe1SmhZ')).toBe('comment_anchor');
    expect(isParseableMarkKey('comment_anchor--c1')).toBe(false);
    expect(isParseableMarkKey('bold')).toBe(true);
  });

  it('rehashes a forced collision deterministically, independent of order', () => {
    expect(markKey(A, colliding)).toBe(markKey(B, colliding));
    const k1 = markKeys([A, B], colliding);
    const k2 = markKeys([B, A], colliding);
    expect(new Set(k1).size).toBe(2);
    expect(k1).toEqual([k2[1], k2[0]]);
    expect(k1).toEqual(['comment_anchor--AAAAAAAA', `comment_anchor--${markIdHash('b:1')}`]);
    // Ids stay in attrs; only the key is salted.
    expect(B.attrs.id).toBe('b');
  });

  it('does not salt different types', () => {
    const s = { type: 'suggestion_insert', attrs: { id: 'b' } };
    expect(markKeys([A, s], colliding)).toEqual([
      'comment_anchor--AAAAAAAA',
      'suggestion_insert--AAAAAAAA',
    ]);
  });
});

describe('freeMarkKey', () => {
  it('returns the first key when free and retries on collision', () => {
    expect(freeMarkKey('comment_anchor', 'c1', 'k', new Set())).toBe('k');
    const next = freeMarkKey('comment_anchor', 'c1', 'k', new Set(['k']));
    expect(next).toMatch(/^comment_anchor--[A-Za-z0-9_-]{8}$/);
  });
  it(`throws after ${MAX_MARK_KEY_TRIES} collisions instead of looping`, () => {
    const constant = () => 'AAAAAAAA';
    const used = new Set(['comment_anchor--AAAAAAAA']);
    expect(() =>
      freeMarkKey('comment_anchor', 'c1', 'comment_anchor--AAAAAAAA', used, constant),
    ).toThrow(/after 1000 tries/);
    expect(() =>
      markKeys(
        [
          { type: 'comment_anchor', attrs: { id: 'a' } },
          { type: 'comment_anchor', attrs: { id: 'b' } },
        ],
        constant,
      ),
    ).toThrow(/after 1000 tries/);
  });
});
