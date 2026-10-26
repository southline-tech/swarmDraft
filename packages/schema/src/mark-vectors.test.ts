/**
 * Cross-language vectors for markIdHash / markKeys, shared with the Rust port
 * (apps/desktop/src-tauri/src/content.rs). Regenerate with
 * UPDATE_FIXTURES=1 pnpm --filter @coauthor/schema test, then review the diff.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { markIdHash, markKeys, type KeyableMark } from './marks';

const FILE = fileURLToPath(
  new URL('../../../fixtures/marks/mark-id-hash-vectors.json', import.meta.url),
);

const HASH_INPUTS = ['c1', 'c1:1', 'c1:2', 's1', '', 'é✓', '42'];

const ca = (id: unknown): KeyableMark => ({ type: 'comment_anchor', attrs: { id } });
const KEY_CASES: { name: string; marks: KeyableMark[] }[] = [
  { name: 'single comment', marks: [ca('c1')] },
  {
    name: 'exclusive marks key by type only',
    marks: [
      { type: 'bold' },
      { type: 'italic', attrs: {} },
      { type: 'link', attrs: { href: 'https://example.com', id: 'l1' } },
    ],
  },
  { name: 'overlap mark without id keys by type', marks: [ca(''), ca(null)] },
  { name: 'numeric id', marks: [ca(42)] },
  { name: 'collision: same id twice', marks: [ca('c1'), ca('c1')] },
  { name: 'collision: three alike', marks: [ca('c1'), ca('c1'), ca('c1')] },
  {
    name: 'id order, not input order',
    marks: [
      { type: 'suggestion_insert', attrs: { id: 's2' } },
      { type: 'suggestion_insert', attrs: { id: 's1' } },
      { type: 'suggestion_insert', attrs: { id: 's1' } },
    ],
  },
  {
    name: 'mixed run',
    marks: [
      { type: 'bold' },
      ca('c1'),
      { type: 'suggestion_delete', attrs: { id: 'c1' } },
      ca('c0'),
    ],
  },
];

function build() {
  return {
    algorithm:
      '64-bit FNV-1a over UTF-8, low 48 bits big-endian, 8 chars standard base64 (no padding); collisions rehash id:n in (id, position) order, max 1000 tries',
    hash: HASH_INPUTS.map((input) => ({ input, hash: markIdHash(input) })),
    keys: KEY_CASES.map((c) => ({ ...c, keys: markKeys(c.marks) })),
  };
}

describe('shared mark key vectors', () => {
  it('match the committed cross-language file', () => {
    const json = JSON.stringify(build(), null, 2) + '\n';
    if (process.env.UPDATE_FIXTURES) writeFileSync(FILE, json);
    const file = JSON.parse(readFileSync(FILE, 'utf8'));
    expect(file).toEqual(build());
    expect(file.hash.find((h: { input: string }) => h.input === 'c1').hash).toBe('fwe1SmhZ');
  });
});
