/**
 * Review decision port (RAD-211 follow-up): turns an accept/reject decision into one ProseMirror
 * transaction on the live editor state. Targets are re-found on the live doc by
 * (mark type, attrs.id), never by Yjs mark keys or stored positions, so edits made since the
 * panel listed the suggestions are kept. Only reachable through `@coauthor/editor/trusted`.
 */
import type { EditorState, Transaction } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';

export type SuggestionMarkType = 'suggestion_insert' | 'suggestion_delete';
export interface ReviewTarget {
  kind: SuggestionMarkType;
  id: string;
}
export type ReviewDecision = 'accept' | 'reject';
export interface ReviewDecisionOp {
  targets: readonly ReviewTarget[];
  decision: ReviewDecision;
}

/**
 * Seam for the review guard's trust marker. Defaults to `allowReviewEdits`; kept as a parameter
 * so the guard integration can change without touching the mapping below.
 */
export type ReviewTrust = (tr: Transaction) => Transaction;

interface JsonMark {
  type: string;
  attrs?: Record<string, unknown>;
}
interface JsonInline {
  type: string;
  text?: string;
  marks?: JsonMark[];
  attrs?: Record<string, unknown>;
}
interface JsonPara {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JsonInline[];
}

const keyOf = (kind: string, id: unknown) => `${kind}\u0000${String(id)}`;

/** Whether text carrying this suggestion is removed by the decision. */
const removes = (kind: string, decision: ReviewDecision) =>
  (kind === 'suggestion_insert') !== (decision === 'accept');

function noteText(content: JsonPara[]): string {
  return content
    .map((p) =>
      (p.content ?? [])
        .map((n) => (n.type === 'text' ? (n.text ?? '') : n.type === 'hard_break' ? '\n' : ''))
        .join(''),
    )
    .join('\n')
    .trim();
}

function decideNoteInline(
  inline: JsonInline[],
  keys: ReadonlySet<string>,
  decision: ReviewDecision,
): JsonInline[] {
  const out: JsonInline[] = [];
  for (const node of inline) {
    if (node.type !== 'text') {
      out.push(node);
      continue;
    }
    let drop = false;
    const marks = (node.marks ?? []).filter((m) => {
      if (!keys.has(keyOf(m.type, m.attrs?.id))) return true;
      if (removes(m.type, decision)) drop = true;
      return false;
    });
    if (drop) continue;
    const next: JsonInline = { type: 'text', text: node.text };
    if (marks.length) next.marks = marks;
    const prev = out[out.length - 1];
    if (
      prev?.type === 'text' &&
      JSON.stringify(prev.marks ?? []) === JSON.stringify(next.marks ?? [])
    )
      out[out.length - 1] = { ...prev, text: (prev.text ?? '') + (next.text ?? '') };
    else out.push(next);
  }
  return out;
}

function noteHasTarget(content: JsonPara[], keys: ReadonlySet<string>): boolean {
  return content.some((p) =>
    (p.content ?? []).some((n) =>
      (n.marks ?? []).some((m) => keys.has(keyOf(m.type, m.attrs?.id))),
    ),
  );
}

/**
 * Build the decision transaction against `state` (the live doc). Ranges are collected by
 * (kind, attrs.id), then applied as mark removals and deletions mapped through the transaction,
 * so the result is a set of local steps, not a whole-document replace. Footnote bodies (kept in
 * attrs) are updated with an attribute step and their `attrs.text` copy recomputed. Returns
 * `null` when no target is present in the live doc.
 */
export function buildReviewTransaction(
  state: EditorState,
  op: ReviewDecisionOp,
  trust: ReviewTrust,
): Transaction | null {
  const keys = new Set(op.targets.map((t) => keyOf(t.kind, t.id)));
  const unmark: { from: number; to: number; mark: PMNode['marks'][number] }[] = [];
  const cut: { from: number; to: number }[] = [];
  const notes: { pos: number; node: PMNode }[] = [];

  state.doc.descendants((node, pos) => {
    if (node.type.name === 'footnote') {
      const content = (node.attrs.content ?? []) as JsonPara[];
      if (noteHasTarget(content, keys)) notes.push({ pos, node });
      return false;
    }
    if (!node.isText) return true;
    let drop = false;
    for (const mark of node.marks) {
      if (!keys.has(keyOf(mark.type.name, mark.attrs.id))) continue;
      if (removes(mark.type.name, op.decision)) drop = true;
      else unmark.push({ from: pos, to: pos + node.nodeSize, mark });
    }
    if (drop) cut.push({ from: pos, to: pos + node.nodeSize });
    return false;
  });

  if (!unmark.length && !cut.length && !notes.length) return null;
  const tr = state.tr;
  for (const u of unmark) tr.removeMark(u.from, u.to, u.mark);
  for (const n of notes) {
    const content = ((n.node.attrs.content ?? []) as JsonPara[]).map((p) => {
      const c = decideNoteInline(p.content ?? [], keys, op.decision);
      const np: JsonPara = { ...p };
      if (c.length) np.content = c;
      else delete np.content;
      return np;
    });
    tr.setNodeMarkup(n.pos, undefined, { ...n.node.attrs, content, text: noteText(content) });
  }
  // Delete from the end so earlier ranges stay valid; map through earlier steps anyway.
  for (const c of [...cut].sort((a, b) => b.from - a.from)) {
    tr.delete(tr.mapping.map(c.from), tr.mapping.map(c.to));
  }
  return trust(tr);
}

/** Minimal view surface (an EditorView or Tiptap's `editor.view`). */
export interface ReviewView {
  state: EditorState;
  dispatch(tr: Transaction): void;
}

/** Build and dispatch the decision on the live view. Returns whether anything changed. */
export function applyReviewDecision(
  view: ReviewView,
  op: ReviewDecisionOp,
  trust: ReviewTrust,
): boolean {
  const tr = buildReviewTransaction(view.state, op, trust);
  if (!tr) return false;
  view.dispatch(tr);
  return true;
}
