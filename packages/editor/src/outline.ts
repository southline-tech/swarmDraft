/**
 * Manuscript outline (RAD-214): the ordered, nested list of sections. Parts hold chapters;
 * front and back matter sit at the top level. Every function is pure and returns a new flat
 * `Section[]` in reading order, so the list can be stored as-is.
 */
import { isSectionKind, sectionDocId, type Section, type SectionKind } from '@coauthor/schema';

export type OutlineNode = Section & { children: OutlineNode[] };

/** Which kinds may contain which. A missing entry means "top level only". */
const PARENT_KINDS: Partial<Record<SectionKind, readonly SectionKind[]>> = {
  chapter: ['part'],
};

export function canNest(child: SectionKind, parent: SectionKind | undefined): boolean {
  const allowed = PARENT_KINDS[child];
  if (parent === undefined) return true;
  return allowed?.includes(parent) ?? false;
}

export const MAX_TITLE_LENGTH = 200;

/**
 * Invisible characters that only cause trouble in a title: bidi embeddings, overrides and
 * isolates (they can make a title display reversed), marks, and zero-width spaces/joiners
 * that carry no meaning on their own. ZWJ and ZWNJ (U+200C/U+200D) stay: emoji sequences and
 * several scripts need them.
 */
const INVISIBLE = /[\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu;

const graphemes = (t: string): string[] =>
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? Array.from(
        new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(t),
        (g) => g.segment,
      )
    : [...t];

/** Title length as a reader counts it (grapheme clusters), the unit of MAX_TITLE_LENGTH. */
export function titleLength(title: string): number {
  return graphemes(title).length;
}

/**
 * Strip control and invisible formatting characters, collapse whitespace and cap the length
 * at MAX_TITLE_LENGTH graphemes, so an emoji or accented letter is never cut in half.
 */
export function cleanTitle(title: string): string {
  const t = title
    .replace(INVISIBLE, '')
    .replace(/[\p{Cc}\u2028\u2029]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Joiners alone render as nothing; treat such a title as empty (rename keeps the old one).
  if (!t.replace(/[\u200C\u200D\s]/gu, '')) return '';
  return graphemes(t).slice(0, MAX_TITLE_LENGTH).join('').trim();
}

export interface OutlineIssue {
  id: string;
  problem: 'duplicate-id' | 'missing-parent' | 'parent-cycle' | 'invalid-nesting' | 'bad-title';
}

/**
 * Repair a stored outline so every function here can trust it. A repeated id on a different
 * docId is a distinct section (its text lives in that doc), so it gets a fresh id and keeps its
 * docId; only an exact repeat (same id and docId) is dropped. Sections whose parent is missing
 * or cannot hold them move to the top level. A parent cycle is broken by moving one section on
 * it to the top level; its subtree stays under it. Titles are cleaned. Returns what it changed.
 */
export function normalizeOutline(sections: readonly Section[]): {
  sections: Section[];
  issues: OutlineIssue[];
} {
  const issues: OutlineIssue[] = [];
  const docOf = new Map<string, string>();
  const list: Section[] = [];
  for (const raw of sections) {
    // Legacy outline rows (no customer data): a scene becomes a sibling chapter under the same part.
    let s = raw;
    if ((raw.kind as string) === 'scene') {
      const parentChapter = raw.parentId ? sections.find((x) => x.id === raw.parentId) : undefined;
      s = { ...raw, kind: 'chapter' };
      if (parentChapter?.parentId) s = { ...s, parentId: parentChapter.parentId };
      else delete (s as { parentId?: string }).parentId;
    }
    if (!isSectionKind(s.kind)) {
      issues.push({ id: s.id, problem: 'invalid-nesting' });
      continue;
    }
    let id = s.id;
    if (docOf.has(id)) {
      issues.push({ id, problem: 'duplicate-id' });
      if (docOf.get(id) === s.docId) continue; // the same section listed twice
      // Deterministic fresh id, so repairing twice gives the same outline.
      let n = 2;
      while (docOf.has(`${s.id}~${n}`) || sections.some((x) => x.id === `${s.id}~${n}`)) n++;
      id = `${s.id}~${n}`;
    }
    docOf.set(id, s.docId);
    const title = cleanTitle(typeof s.title === 'string' ? s.title : '');
    if (title !== s.title) issues.push({ id, problem: 'bad-title' });
    list.push({ ...s, id, title });
  }
  const byId = new Map(list.map((s) => [s.id, s]));
  const detach = (s: Section, problem: OutlineIssue['problem']) => {
    issues.push({ id: s.id, problem });
    delete s.parentId;
  };
  for (const s of list) {
    if (s.parentId === undefined) continue;
    if (!byId.has(s.parentId)) {
      detach(s, 'missing-parent');
      continue;
    }
    // Walk up; only a walk that returns to s itself means s is on a cycle. Detaching s breaks
    // that cycle, so sections merely under it (and the rest of the cycle) keep their parents.
    const visited = new Set([s.id]);
    let p: string | undefined = s.parentId;
    while (p !== undefined && !visited.has(p)) {
      visited.add(p);
      p = byId.get(p)?.parentId;
    }
    if (p === s.id) detach(s, 'parent-cycle');
  }
  for (const s of list) {
    const parent = s.parentId === undefined ? undefined : byId.get(s.parentId);
    if (parent && !canNest(s.kind, parent.kind)) detach(s, 'invalid-nesting');
  }
  return { sections: flatten(treeOf(list)), issues };
}

function treeOf(sections: readonly Section[]): OutlineNode[] {
  const nodes = new Map<string, OutlineNode>();
  for (const s of sections) if (!nodes.has(s.id)) nodes.set(s.id, { ...s, children: [] });
  const roots: OutlineNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  return roots;
}

/**
 * Nested view of the outline. Input is normalized first, so a corrupt list (cycles, missing
 * parents, repeated ids) still shows every section exactly once.
 */
export function buildOutline(sections: readonly Section[]): OutlineNode[] {
  return treeOf(normalizeOutline(sections).sections);
}

function flatten(nodes: readonly OutlineNode[], out: Section[] = []): Section[] {
  for (const { children, ...s } of nodes) {
    out.push(s);
    flatten(children, out);
  }
  return out;
}

function siblingsOf(roots: OutlineNode[], parentId: string | undefined): OutlineNode[] | undefined {
  if (!parentId) return roots;
  const find = (list: OutlineNode[]): OutlineNode | undefined => {
    for (const n of list) {
      if (n.id === parentId) return n;
      const hit = find(n.children);
      if (hit) return hit;
    }
    return undefined;
  };
  return find(roots)?.children;
}

export interface NewSection {
  manuscriptId: string;
  kind: SectionKind;
  title: string;
  parentId?: string;
  /** Defaults to a random UUID. */
  id?: string;
}

/**
 * Where a new top-level section goes: front matter after the existing front matter, back matter
 * at the end, anything else before the back matter. Nested sections append to their parent.
 */
function insertIndex(
  siblings: readonly OutlineNode[],
  kind: SectionKind,
  topLevel: boolean,
): number {
  if (!topLevel || kind === 'back_matter') return siblings.length;
  if (kind === 'front_matter') {
    let i = 0;
    siblings.forEach((s, j) => s.kind === 'front_matter' && (i = j + 1));
    return i;
  }
  const back = siblings.findIndex((s) => s.kind === 'back_matter');
  return back < 0 ? siblings.length : back;
}

/** Add a section under its parent (or at the top level, see insertIndex). Throws if it cannot nest there. */
export function addSection(sections: readonly Section[], n: NewSection): Section[] {
  const parent = n.parentId ? sections.find((s) => s.id === n.parentId) : undefined;
  if (n.parentId && !parent) throw new Error(`unknown parent ${n.parentId}`);
  if (!canNest(n.kind, parent?.kind)) throw new Error(`a ${n.kind} cannot go there`);
  const id = n.id ?? crypto.randomUUID();
  if (sections.some((s) => s.id === id)) throw new Error(`duplicate id ${id}`);
  const section: Section = {
    id,
    kind: n.kind,
    title: cleanTitle(n.title),
    docId: sectionDocId(n.manuscriptId, id),
    ...(n.parentId ? { parentId: n.parentId } : {}),
  };
  const roots = buildOutline(sections);
  const siblings = siblingsOf(roots, n.parentId)!;
  siblings.splice(insertIndex(siblings, n.kind, !n.parentId), 0, { ...section, children: [] });
  return flatten(roots);
}

export function renameSection(sections: readonly Section[], id: string, title: string): Section[] {
  const clean = cleanTitle(title);
  if (!clean) return [...sections];
  return sections.map((s) => (s.id === id ? { ...s, title: clean } : s));
}

/** Sections under `id` (all depths). */
export function descendantsOf(sections: readonly Section[], id: string): Section[] {
  const out: Section[] = [];
  const walk = (nodes: OutlineNode[]) => nodes.forEach((n) => (out.push(n), walk(n.children)));
  const find = (nodes: OutlineNode[]): OutlineNode | undefined => {
    for (const n of nodes) {
      if (n.id === id) return n;
      const hit = find(n.children);
      if (hit) return hit;
    }
    return undefined;
  };
  walk(find(buildOutline(sections))?.children ?? []);
  return out.map(({ ...s }) => {
    delete (s as Partial<OutlineNode>).children;
    return s;
  });
}

/**
 * Whether `id`'s direct children can move up to its parent when it is deleted (e.g. a chapter's
 * direct children cannot go to the top level).
 */
export function canPromoteChildren(sections: readonly Section[], id: string): boolean {
  const s = sections.find((x) => x.id === id);
  if (!s) return false;
  const parent = s.parentId ? sections.find((x) => x.id === s.parentId) : undefined;
  return sections.filter((c) => c.parentId === id).every((c) => canNest(c.kind, parent?.kind));
}

/**
 * Delete a section. `children: 'delete'` removes everything under it too; `'promote'` moves its
 * direct children into its place (throws if they cannot nest there). Throws for an unknown id.
 */
export function deleteSection(
  sections: readonly Section[],
  id: string,
  opts: { children: 'delete' | 'promote' },
): Section[] {
  const list = normalizeOutline(sections).sections;
  const s = list.find((x) => x.id === id);
  if (!s) throw new Error(`unknown section ${id}`);
  if (opts.children === 'delete') {
    const gone = new Set([id, ...descendantsOf(list, id).map((d) => d.id)]);
    return list.filter((x) => !gone.has(x.id));
  }
  if (!canPromoteChildren(list, id)) throw new Error('its contents cannot move up a level');
  return list
    .filter((x) => x.id !== id)
    .map((x) => {
      if (x.parentId !== id) return x;
      const next = { ...x };
      delete next.parentId;
      if (s.parentId) next.parentId = s.parentId;
      return next;
    });
}

/** Parents `id` could be moved into with `dropSection` (undefined = top level). */
export function validParents(sections: readonly Section[], id: string): (Section | undefined)[] {
  const s = sections.find((x) => x.id === id);
  if (!s) return [];
  const below = new Set([id, ...descendantsOf(sections, id).map((d) => d.id)]);
  const out: (Section | undefined)[] = canNest(s.kind, undefined) ? [undefined] : [];
  for (const p of normalizeOutline(sections).sections)
    if (!below.has(p.id) && canNest(s.kind, p.kind)) out.push(p);
  return out;
}

/** Move a section (with everything under it) one place up (-1) or down (+1) among its siblings. */
export function moveSection(sections: readonly Section[], id: string, delta: -1 | 1): Section[] {
  sections = normalizeOutline(sections).sections;
  const s = sections.find((x) => x.id === id);
  if (!s) return [...sections];
  const roots = buildOutline(sections);
  const sibs = siblingsOf(roots, s.parentId)!;
  const i = sibs.findIndex((x) => x.id === id);
  const j = i + delta;
  if (j < 0 || j >= sibs.length) return [...sections];
  [sibs[i], sibs[j]] = [sibs[j]!, sibs[i]!];
  return flatten(roots);
}

/**
 * Drop `id` directly before `beforeId` (same parent as it), or at the end of `parentId` when
 * `beforeId` is omitted. Returns the list unchanged if the move is not allowed (wrong nesting,
 * or into its own subtree).
 */
export function dropSection(
  sections: readonly Section[],
  id: string,
  target: { beforeId?: string; parentId?: string },
): Section[] {
  sections = normalizeOutline(sections).sections;
  const s = sections.find((x) => x.id === id);
  const before = target.beforeId ? sections.find((x) => x.id === target.beforeId) : undefined;
  if (!s || (target.beforeId && !before) || target.beforeId === id) return [...sections];
  const parentId = before ? before.parentId : target.parentId;
  // Normalized input has no cycles, but bound the walk anyway.
  const visited = new Set<string>();
  for (let p = parentId; p && !visited.has(p); p = sections.find((x) => x.id === p)?.parentId) {
    if (p === id) return [...sections];
    visited.add(p);
  }
  const parent = parentId ? sections.find((x) => x.id === parentId) : undefined;
  if (!canNest(s.kind, parent?.kind)) return [...sections];

  const roots = buildOutline(sections);
  const from = siblingsOf(roots, s.parentId)!;
  const [node] = from.splice(
    from.findIndex((x) => x.id === id),
    1,
  );
  const moved: OutlineNode = { ...node! };
  delete moved.parentId;
  if (parentId) moved.parentId = parentId;
  const to = siblingsOf(roots, parentId)!;
  const at = before ? to.findIndex((x) => x.id === before.id) : to.length;
  to.splice(at, 0, moved);
  return flatten(roots);
}

/**
 * Run one outline edit all-or-nothing: the result is used only if the edit did not throw and
 * left a consistent outline (no repaired issues); otherwise the original list comes back with
 * the error. Callers persist `sections` only when `ok`.
 */
export function applyOutlineEdit(
  sections: readonly Section[],
  edit: (s: Section[]) => Section[],
): { ok: true; sections: Section[] } | { ok: false; sections: Section[]; error: Error } {
  const original = [...sections];
  try {
    const next = edit(normalizeOutline(sections).sections);
    const { issues } = normalizeOutline(next);
    if (issues.length)
      throw new Error(`edit left the outline inconsistent (${issues[0]!.problem})`);
    return { ok: true, sections: next };
  } catch (e) {
    return { ok: false, sections: original, error: e instanceof Error ? e : new Error(String(e)) };
  }
}
