/**
 * Review decision port (RAD-211 follow-up): turns an accept/reject decision into one ProseMirror
 * transaction on the live editor state. Targets are re-found on the live doc by
 * (mark type, attrs.id), never by Yjs mark keys or stored positions, so edits made since the
 * panel listed the suggestions are kept. Only reachable through `@coauthor/editor/trusted`.
 */
import type { EditorState, Transaction } from '@tiptap/pm/state';
import type { Mark as PMMark, Node as PMNode } from '@tiptap/pm/model';
import type { ParagraphStyle } from '@coauthor/schema';
import { inlineFormatOnBefore, PARAGRAPH_STYLE_TARGET, readFormatAttrs } from './format-change';

export type SuggestionMarkType = 'suggestion_insert' | 'suggestion_delete' | 'format_change';
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

interface BlockSplitInsertAttrs {
  id: string;
  author: string;
  ts: string;
}

function joinBlockAtIndex(tr: Transaction, blockIndex: number): Transaction {
  if (blockIndex <= 0 || blockIndex >= tr.doc.childCount) return tr;
  let pos = 0;
  for (let i = 0; i < blockIndex; i++) pos += tr.doc.child(i).nodeSize;
  pos = tr.mapping.map(pos);
  const cur = tr.doc.child(blockIndex);
  if (!cur.content.size) return tr.delete(pos, pos + cur.nodeSize);
  const insertAt = pos - 1;
  const content = cur.content;
  tr = tr.delete(pos, pos + cur.nodeSize);
  return tr.insert(tr.mapping.map(insertAt), content);
}

/** Whether text carrying this insert/delete suggestion is removed by the decision. */
const removesInsertDelete = (kind: string, decision: ReviewDecision) =>
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
    let revertAttrs: ReturnType<typeof readFormatAttrs> | undefined;
    const marks = (node.marks ?? []).filter((m) => {
      const k = keyOf(m.type, m.attrs?.id);
      if (!keys.has(k)) return true;
      if (m.type === 'format_change') {
        if (decision === 'reject') revertAttrs = readFormatAttrs(m.attrs ?? {});
        return false;
      }
      if (removesInsertDelete(m.type, decision)) drop = true;
      return false;
    });
    if (drop) continue;
    let nextMarks = marks;
    if (revertAttrs && revertAttrs.target !== PARAGRAPH_STYLE_TARGET) {
      const on = inlineFormatOnBefore(revertAttrs.target, revertAttrs.before);
      nextMarks = marks.filter((m) => m.type !== revertAttrs!.target);
      if (on) nextMarks = [...nextMarks, { type: revertAttrs.target }];
    }
    const next: JsonInline = { type: 'text', text: node.text };
    if (nextMarks.length) next.marks = nextMarks;
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

function applyInlineFormatReject(
  tr: Transaction,
  schema: EditorState['schema'],
  from: number,
  to: number,
  attrs: NonNullable<ReturnType<typeof readFormatAttrs>>,
  mark: PMMark,
): Transaction {
  if (attrs.target === PARAGRAPH_STYLE_TARGET) return tr;
  const type = schema.marks[attrs.target];
  if (!type) return tr.removeMark(from, to, mark);
  const on = inlineFormatOnBefore(attrs.target, attrs.before);
  if (on) tr = tr.addMark(from, to, type.create());
  else tr = tr.removeMark(from, to, type);
  return tr.removeMark(from, to, mark);
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
  const unmark: { from: number; to: number; mark: PMMark }[] = [];
  const cut: { from: number; to: number }[] = [];
  const notes: { pos: number; node: PMNode }[] = [];
  const splitJoinBlocks = new Set<number>();
  const splitParaAccept: number[] = [];
  const paragraphStyleReject = new Map<number, ParagraphStyle>();
  const formatReject: {
    from: number;
    to: number;
    attrs: NonNullable<ReturnType<typeof readFormatAttrs>>;
    mark: PMMark;
  }[] = [];

  state.doc.descendants((node, pos) => {
    if (node.type.name === 'footnote') {
      const content = (node.attrs.content ?? []) as JsonPara[];
      if (noteHasTarget(content, keys)) notes.push({ pos, node });
      return false;
    }
    if (node.type.name === 'paragraph') {
      const bsi = node.attrs.blockSplitInsert as BlockSplitInsertAttrs | null | undefined;
      if (bsi?.id && keys.has(keyOf('suggestion_insert', bsi.id))) {
        const blockIndex = state.doc.resolve(pos).index(0);
        if (op.decision === 'accept') splitParaAccept.push(pos);
        else if (blockIndex > 0) splitJoinBlocks.add(blockIndex);
      }
      if (op.decision === 'reject') {
        node.forEach((child) => {
          if (!child.isText) return;
          for (const mark of child.marks) {
            if (mark.type.name !== 'format_change') continue;
            if (!keys.has(keyOf('format_change', mark.attrs.id))) continue;
            const attrs = readFormatAttrs(mark.attrs);
            if (attrs?.target === PARAGRAPH_STYLE_TARGET)
              paragraphStyleReject.set(pos, attrs.before as ParagraphStyle);
          }
        });
      }
    }
    if (!node.isText) return true;
    let drop = false;
    for (const mark of node.marks) {
      const k = keyOf(mark.type.name, mark.attrs.id);
      if (!keys.has(k)) continue;
      if (mark.type.name === 'format_change') {
        if (op.decision === 'accept') unmark.push({ from: pos, to: pos + node.nodeSize, mark });
        else {
          const attrs = readFormatAttrs(mark.attrs);
          if (attrs?.target === PARAGRAPH_STYLE_TARGET)
            unmark.push({ from: pos, to: pos + node.nodeSize, mark });
          else if (attrs) formatReject.push({ from: pos, to: pos + node.nodeSize, attrs, mark });
        }
        continue;
      }
      if (removesInsertDelete(mark.type.name, op.decision)) {
        if (
          op.decision === 'reject' &&
          mark.type.name === 'suggestion_insert' &&
          mark.attrs.blockSplit
        ) {
          unmark.push({ from: pos, to: pos + node.nodeSize, mark });
          const blockIndex = state.doc.resolve(pos).index(0);
          if (blockIndex > 0) splitJoinBlocks.add(blockIndex);
          continue;
        }
        drop = true;
      } else {
        unmark.push({ from: pos, to: pos + node.nodeSize, mark });
        if (
          op.decision === 'accept' &&
          mark.type.name === 'suggestion_insert' &&
          node.text === '\u200b'
        ) {
          drop = true;
        }
      }
    }
    if (drop) cut.push({ from: pos, to: pos + node.nodeSize });
    return false;
  });

  if (
    !unmark.length &&
    !cut.length &&
    !notes.length &&
    !paragraphStyleReject.size &&
    !formatReject.length &&
    !splitParaAccept.length &&
    !splitJoinBlocks.size
  )
    return null;
  let tr = state.tr;
  for (const [pos, style] of paragraphStyleReject)
    tr = tr.setNodeMarkup(pos, undefined, { ...state.doc.nodeAt(pos)!.attrs, style });
  for (const f of formatReject)
    tr = applyInlineFormatReject(tr, state.schema, f.from, f.to, f.attrs, f.mark);
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
  for (const c of [...cut].sort((a, b) => b.from - a.from)) {
    tr.delete(tr.mapping.map(c.from), tr.mapping.map(c.to));
  }
  for (const pos of [...splitParaAccept].sort((a, b) => b - a)) {
    const mapped = tr.mapping.map(pos);
    const node = tr.doc.nodeAt(mapped);
    if (!node) continue;
    const { blockSplitInsert: _drop, ...attrs } = node.attrs;
    tr = tr.setNodeMarkup(mapped, undefined, attrs);
  }
  for (const blockIndex of [...splitJoinBlocks].sort((a, b) => b - a)) {
    tr = joinBlockAtIndex(tr, blockIndex);
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
