/**
 * Yjs attribute keys for marks (y-prosemirror encoding). Exclusive marks are keyed by type.
 * Marks that may overlap another of the same type (comments, suggestions) are keyed
 * `type--<8 base64>`: y-prosemirror only parses `--` plus exactly 8 chars as an overlap key, so
 * the suffix is a 48-bit FNV-1a hash of the mark id as 8 base64 chars. The id itself stays in the
 * attrs, and readers must identify a mark by `attrs.id`, never by its key: the editor binding
 * rewrites the suffix with its own hash whenever it writes the run (e.g. `fwe1SmhZ` becomes
 * `Ql7mhpA0` after typing in that paragraph).
 * Rust mirrors this; test vector: markIdHash('c1') === MARK_ID_HASH_TEST_VECTOR[1].
 */
import { NON_EXCLUSIVE_MARKS } from './content';

export const MARK_ID_HASH_TEST_VECTOR = ['c1', 'fwe1SmhZ'] as const;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * 64-bit FNV-1a over the UTF-8 bytes of `s`; the low 48 bits, big-endian, as 8 chars of
 * standard base64 (no padding). Matches y-prosemirror's `--[a-zA-Z0-9+/=]{8}` overlap suffix.
 */
export function markIdHash(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(s))
    h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n);
  let out = '';
  for (let shift = 42n; shift >= 0n; shift -= 6n) out += B64[Number((h >> shift) & 63n)];
  return out;
}

export interface KeyableMark {
  type: string;
  attrs?: Record<string, unknown>;
}

function overlapId(m: KeyableMark): string | undefined {
  const id = m.attrs?.id;
  if (!(NON_EXCLUSIVE_MARKS as readonly string[]).includes(m.type)) return undefined;
  if (typeof id === 'string' && id) return id;
  if (typeof id === 'number') return String(id);
  return undefined;
}

/** Key for a single mark, ignoring collisions (use markKeys for a run's full mark set). */
export function markKey(m: KeyableMark, hash: (s: string) => string = markIdHash): string {
  const id = overlapId(m);
  return id === undefined ? m.type : `${m.type}--${hash(id)}`;
}

/**
 * Keys for all marks on one text range, unique within the range. When two distinct marks of
 * the same type hash alike, the later one (in id order, so the result does not depend on mark
 * order) is rehashed as hash(id + ':' + n) for n = 1, 2, ... until free.
 */
export function markKeys(
  marks: readonly KeyableMark[],
  hash: (s: string) => string = markIdHash,
): string[] {
  const order = marks
    .map((m, i) => ({ i, id: overlapId(m) ?? '' }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.i - b.i));
  const used = new Set<string>();
  const keys: string[] = new Array(marks.length);
  for (const { i, id } of order) {
    const m = marks[i]!;
    let key = markKey(m, hash);
    for (let n = 1; id && used.has(key); n++) key = `${m.type}--${hash(`${id}:${n}`)}`;
    used.add(key);
    keys[i] = key;
  }
  return keys;
}

export function markTypeFromKey(key: string): string {
  const i = key.indexOf('--');
  return i < 0 ? key : key.slice(0, i);
}

/** True for a key a y-prosemirror binding can parse (plain type or `type--<8 chars>`). */
export function isParseableMarkKey(key: string): boolean {
  return !key.includes('--') || /^[^-]+(?:_[^-]+)*--[a-zA-Z0-9+/=]{8}$/.test(key);
}
