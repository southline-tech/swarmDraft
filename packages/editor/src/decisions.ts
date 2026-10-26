/**
 * Tracked-change decisions (RAD-211), as pure functions over the shared content model in
 * `@coauthor/schema`. Accepting or rejecting is a human-only desktop action: nothing here is
 * exposed to agents, and the MCP surface has no equivalent.
 *
 * The editor applies a decision through a `ReviewTransactionPort` (one ProseMirror transaction
 * carrying the `allowReviewEdits` meta, so it is a single undo step and syncs through Yjs), and
 * records it in the suggestion index through a `SuggestionDecisionSink`. Both are seams so this
 * module does not depend on the editor or the database layer.
 *
 * Suggestion ids are always read from mark attrs, never from Yjs mark keys.
 */
import type { BlockNode, DocNode, InlineNode, Mark, TextNode } from '@coauthor/schema';

export type SuggestionKind = 'suggestion_insert' | 'suggestion_delete';
export type Decision = 'accept' | 'reject';

export interface SuggestionItem {
  id: string;
  kind: SuggestionKind;
  author: string;
  ts: string;
  /** Text covered by the suggestion, joined across text nodes in reading order. */
  text: string;
}

export type DecisionScope =
  { kind: 'one'; id: string } | { kind: 'author'; author: string } | { kind: 'all' };

export interface DecisionRecord {
  id: string;
  status: 'accepted' | 'rejected';
  decidedAt: string;
  decidedBy: string;
}

/** Applies a new document in one trusted transaction (sets `allowReviewEdits`). */
export interface ReviewTransactionPort {
  applyReviewDecision(next: DocNode): void | Promise<void>;
}
/** Writes status/decided_at/decided_by to the suggestion index. */
export interface SuggestionDecisionSink {
  recordDecisions(records: DecisionRecord[]): void | Promise<void>;
}

type SuggestionMark = Extract<Mark, { type: SuggestionKind }>;
const isSuggestion = (m: Mark): m is SuggestionMark =>
  m.type === 'suggestion_insert' || m.type === 'suggestion_delete';

function inlineOf(block: BlockNode): InlineNode[] | undefined {
  return 'content' in block ? block.content : undefined;
}

/** Suggestions in reading order, one entry per (kind, id). */
export function listSuggestions(doc: DocNode): SuggestionItem[] {
  const byKey = new Map<string, SuggestionItem>();
  for (const block of doc.content) {
    for (const node of inlineOf(block) ?? []) {
      if (node.type !== 'text') continue;
      for (const m of node.marks ?? []) {
        if (!isSuggestion(m)) continue;
        const key = `${m.type}\u0000${m.attrs.id}`;
        const item = byKey.get(key);
        if (item) item.text += node.text;
        else
          byKey.set(key, {
            id: m.attrs.id,
            kind: m.type,
            author: m.attrs.author,
            ts: m.attrs.ts,
            text: node.text,
          });
      }
    }
  }
  return [...byKey.values()];
}

export function selectSuggestionIds(items: SuggestionItem[], scope: DecisionScope): Set<string> {
  if (scope.kind === 'one') return new Set(items.some((i) => i.id === scope.id) ? [scope.id] : []);
  if (scope.kind === 'author')
    return new Set(items.filter((i) => i.author === scope.author).map((i) => i.id));
  return new Set(items.map((i) => i.id));
}

export interface DecisionResult {
  doc: DocNode;
  /** Ids that were decided. */
  decided: string[];
  /** Ids whose text disappeared because an overlapping suggestion was decided. */
  superseded: string[];
}

/**
 * Decide the selected suggestions. Accepting an insert or rejecting a delete keeps the text and
 * drops the mark; accepting a delete or rejecting an insert removes the text. When suggestions
 * overlap, text removed by one decision also removes the other marks on it; those ids are
 * reported as `superseded` if none of their text survives.
 */
export function decideSuggestions(
  doc: DocNode,
  ids: ReadonlySet<string>,
  decision: Decision,
): DecisionResult {
  const before = listSuggestions(doc);
  const decided = before.filter((i) => ids.has(i.id)).map((i) => i.id);
  const content = doc.content.map((block): BlockNode => {
    const inline = inlineOf(block);
    if (!inline) return block;
    const out: InlineNode[] = [];
    for (const node of inline) {
      if (node.type !== 'text') {
        out.push(node);
        continue;
      }
      let remove = false;
      const marks = (node.marks ?? []).filter((m) => {
        if (!isSuggestion(m) || !ids.has(m.attrs.id)) return true;
        const kept = (m.type === 'suggestion_insert') === (decision === 'accept');
        if (!kept) remove = true;
        return false;
      });
      if (remove) continue;
      const next: TextNode = { type: 'text', text: node.text };
      if (marks.length) next.marks = marks;
      const prev = out[out.length - 1];
      if (prev?.type === 'text' && sameMarks(prev.marks, next.marks)) {
        out[out.length - 1] = { ...prev, text: prev.text + next.text };
      } else out.push(next);
    }
    const nb = { ...block } as BlockNode & { content?: InlineNode[] };
    if (out.length) nb.content = out;
    else delete nb.content;
    return nb;
  });
  const next: DocNode = { ...doc, content };
  const remaining = new Set(listSuggestions(next).map((i) => i.id));
  const superseded = [
    ...new Set(before.filter((i) => !ids.has(i.id) && !remaining.has(i.id)).map((i) => i.id)),
  ];
  return { doc: next, decided: [...new Set(decided)], superseded };
}

function sameMarks(a: Mark[] | undefined, b: Mark[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

/**
 * Run a decision end to end: one trusted transaction, then the index update. Superseded
 * suggestions are recorded as rejected, since their text no longer exists.
 */
export async function runDecision(
  doc: DocNode,
  scope: DecisionScope,
  decision: Decision,
  ctx: {
    tx: ReviewTransactionPort;
    sink?: SuggestionDecisionSink;
    decidedBy: string;
    now?: () => Date;
  },
): Promise<DecisionResult> {
  const ids = selectSuggestionIds(listSuggestions(doc), scope);
  const result = decideSuggestions(doc, ids, decision);
  if (!result.decided.length) return result;
  await ctx.tx.applyReviewDecision(result.doc);
  const decidedAt = (ctx.now?.() ?? new Date()).toISOString();
  const status = decision === 'accept' ? 'accepted' : 'rejected';
  await ctx.sink?.recordDecisions([
    ...result.decided.map((id) => ({ id, status, decidedAt, decidedBy: ctx.decidedBy }) as const),
    ...result.superseded.map(
      (id) => ({ id, status: 'rejected', decidedAt, decidedBy: ctx.decidedBy }) as const,
    ),
  ]);
  return result;
}

/** Stable per-author color for suggestion highlighting. */
export function authorColor(author: string): string {
  let h = 0;
  for (const ch of author) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return `hsl(${h % 360} 70% 45%)`;
}
