/**
 * Manuscript outline (RAD-214): the ordered, nested list of sections. Parts hold chapters,
 * chapters hold scenes; front and back matter sit at the top level. Every function is pure and
 * returns a new flat `Section[]` in reading order, so the list can be stored as-is.
 */
import { sectionDocId, type Section, type SectionKind } from '@coauthor/schema';

export type OutlineNode = Section & { children: OutlineNode[] };

/** Which kinds may contain which. A missing entry means "top level only". */
const PARENT_KINDS: Partial<Record<SectionKind, readonly SectionKind[]>> = {
  chapter: ['part'],
  scene: ['chapter'],
};

export function canNest(child: SectionKind, parent: SectionKind | undefined): boolean {
  const allowed = PARENT_KINDS[child];
  if (parent === undefined) return child !== 'scene';
  return allowed?.includes(parent) ?? false;
}

export function buildOutline(sections: readonly Section[]): OutlineNode[] {
  const nodes = new Map(sections.map((s) => [s.id, { ...s, children: [] as OutlineNode[] }]));
  const roots: OutlineNode[] = [];
  for (const s of sections) {
    const node = nodes.get(s.id)!;
    const parent = s.parentId ? nodes.get(s.parentId) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  return roots;
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

/** Append a section at the end of its parent (or the top level). Throws if it cannot nest there. */
export function addSection(sections: readonly Section[], n: NewSection): Section[] {
  const parent = n.parentId ? sections.find((s) => s.id === n.parentId) : undefined;
  if (n.parentId && !parent) throw new Error(`unknown parent ${n.parentId}`);
  if (!canNest(n.kind, parent?.kind)) throw new Error(`a ${n.kind} cannot go there`);
  const id = n.id ?? crypto.randomUUID();
  const section: Section = {
    id,
    kind: n.kind,
    title: n.title,
    docId: sectionDocId(n.manuscriptId, id),
    ...(n.parentId ? { parentId: n.parentId } : {}),
  };
  const roots = buildOutline(sections);
  siblingsOf(roots, n.parentId)!.push({ ...section, children: [] });
  return flatten(roots);
}

export function renameSection(sections: readonly Section[], id: string, title: string): Section[] {
  return sections.map((s) => (s.id === id ? { ...s, title } : s));
}

/** Move a section (with everything under it) one place up (-1) or down (+1) among its siblings. */
export function moveSection(sections: readonly Section[], id: string, delta: -1 | 1): Section[] {
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
  const s = sections.find((x) => x.id === id);
  const before = target.beforeId ? sections.find((x) => x.id === target.beforeId) : undefined;
  if (!s || (target.beforeId && !before) || target.beforeId === id) return [...sections];
  const parentId = before ? before.parentId : target.parentId;
  for (let p = parentId; p; p = sections.find((x) => x.id === p)?.parentId)
    if (p === id) return [...sections];
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
