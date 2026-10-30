/**
 * Tracked-change decisions (RAD-211). Accepting or rejecting is a human-only desktop action:
 * nothing here is exposed to agents, and the MCP surface has no equivalent.
 *
 * A decision travels as a `DecisionOp` (target (kind, id) pairs plus accept/reject), never as a
 * replacement document. The editor's `ReviewTransactionPort` (in `@coauthor/editor/trusted`)
 * re-finds each target on the live document by `attrs.id` inside one `allowReviewEdits`
 * transaction, so concurrent edits elsewhere survive and the decision is one undo step.
 * `decideSuggestions` is the reference model of that transform over the shared content model.
 *
 * Suggestion ids are always read from mark attrs, never from Yjs mark keys.
 */
import type {
  BlockNode,
  DocNode,
  InlineNode,
  Mark,
  ParagraphNode,
  TextNode,
} from '@coauthor/schema';

export type SuggestionKind = 'suggestion_insert' | 'suggestion_delete';
export type Decision = 'accept' | 'reject';

export interface SuggestionItem {
  id: string;
  kind: SuggestionKind;
  author: string;
  ts: string;
  /** Text covered by the suggestion, joined across text nodes in reading order (incl. notes). */
  text: string;
}

export type DecisionScope =
  | { kind: 'one'; id: string; suggestion: SuggestionKind }
  | { kind: 'author'; author: string }
  | { kind: 'all' };

export interface SuggestionTarget {
  kind: SuggestionKind;
  id: string;
}
export interface DecisionOp {
  targets: SuggestionTarget[];
  decision: Decision;
}

export interface DecisionRecord {
  id: string;
  kind: SuggestionKind;
  status: 'accepted' | 'rejected';
  decidedAt: string;
  decidedBy: string;
}

const DECISION_KINDS: readonly SuggestionKind[] = ['suggestion_insert', 'suggestion_delete'];
const DECISION_STATUSES = ['accepted', 'rejected'] as const;

/** Narrow persisted JSON to a decision record (#51). */
export function parseDecisionRecord(value: unknown): DecisionRecord | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const kind = v.kind;
  const id = v.id;
  const status = v.status;
  const decidedAt = v.decidedAt;
  const decidedBy = v.decidedBy;
  if (typeof id !== 'string' || !id) return null;
  if (typeof decidedAt !== 'string' || !decidedAt) return null;
  if (typeof decidedBy !== 'string' || !decidedBy) return null;
  if (!DECISION_KINDS.includes(kind as SuggestionKind)) return null;
  if (!DECISION_STATUSES.includes(status as (typeof DECISION_STATUSES)[number])) return null;
  return {
    id,
    kind: kind as SuggestionKind,
    status: status as 'accepted' | 'rejected',
    decidedAt,
    decidedBy,
  };
}

/** Parse and dedupe persisted rows (last wins per target key). */
export function parseDecisionRecords(values: unknown): DecisionRecord[] {
  const out = new Map<string, DecisionRecord>();
  if (!Array.isArray(values)) return [];
  for (const raw of values) {
    const r = parseDecisionRecord(raw);
    if (r) out.set(targetKey(r), r);
  }
  return [...out.values()];
}

/** Writes status/decided_at/decided_by to the suggestion index. */
export interface SuggestionDecisionSink {
  recordDecisions(records: DecisionRecord[]): void | Promise<void>;
}

export interface PortResult {
  decided: SuggestionTarget[];
  superseded: SuggestionTarget[];
}
/**
 * Applies a decision op to the live document in one trusted transaction. The implementation
 * lives behind `@coauthor/editor/trusted`.
 */
export interface ReviewTransactionPort {
  applyReviewDecision(op: DecisionOp): PortResult | Promise<PortResult>;
}

type SuggestionMark = Extract<Mark, { type: SuggestionKind }>;
const isSuggestion = (m: Mark): m is SuggestionMark =>
  m.type === 'suggestion_insert' || m.type === 'suggestion_delete';
export const targetKey = (t: SuggestionTarget) => `${t.kind}\u0000${t.id}`;

function inlineOf(block: BlockNode): InlineNode[] | undefined {
  return 'content' in block ? block.content : undefined;
}

function walkText(inline: InlineNode[] | undefined, visit: (t: TextNode) => void): void {
  for (const node of inline ?? []) {
    if (node.type === 'text') visit(node);
    else if (node.type === 'footnote')
      for (const p of node.attrs.content) walkText(p.content, visit);
  }
}

/** Suggestions in reading order (footnote content included), one entry per (kind, id). */
export function listSuggestions(doc: DocNode): SuggestionItem[] {
  const byKey = new Map<string, SuggestionItem>();
  for (const block of doc.content) {
    walkText(inlineOf(block), (node) => {
      for (const m of node.marks ?? []) {
        if (!isSuggestion(m)) continue;
        const key = targetKey({ kind: m.type, id: m.attrs.id });
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
    });
  }
  return [...byKey.values()];
}

export function selectTargets(items: SuggestionItem[], scope: DecisionScope): SuggestionTarget[] {
  const pick =
    scope.kind === 'one'
      ? (i: SuggestionItem) => i.id === scope.id && i.kind === scope.suggestion
      : scope.kind === 'author'
        ? (i: SuggestionItem) => i.author === scope.author
        : () => true;
  return items.filter(pick).map(({ kind, id }) => ({ kind, id }));
}

export interface DecisionResult extends PortResult {
  doc: DocNode;
}

function transformInline(
  inline: InlineNode[],
  keys: ReadonlySet<string>,
  decision: Decision,
): InlineNode[] {
  const out: InlineNode[] = [];
  for (const node of inline) {
    if (node.type === 'footnote') {
      const content = node.attrs.content.map((p): ParagraphNode => {
        const c = transformInline(p.content ?? [], keys, decision);
        const np: ParagraphNode = { ...p };
        if (c.length) np.content = c;
        else delete np.content;
        return np;
      });
      // Keep the plain-text copy in sync: agents read `attrs.text` (docx readView).
      out.push({ ...node, attrs: { ...node.attrs, content, text: noteText(content) } });
      continue;
    }
    if (node.type !== 'text') {
      out.push(node);
      continue;
    }
    let remove = false;
    const marks = (node.marks ?? []).filter((m) => {
      if (!isSuggestion(m) || !keys.has(targetKey({ kind: m.type, id: m.attrs.id }))) return true;
      if ((m.type === 'suggestion_insert') !== (decision === 'accept')) remove = true;
      return false;
    });
    if (remove) continue;
    const next: TextNode = { type: 'text', text: node.text };
    if (marks.length) next.marks = marks;
    const prev = out[out.length - 1];
    if (prev?.type === 'text' && sameMarks(prev.marks, next.marks))
      out[out.length - 1] = { ...prev, text: prev.text + next.text };
    else out.push(next);
  }
  return out;
}

/**
 * Reference model: apply a decision op to `doc`, locating targets by (kind, attrs.id).
 * Accepting an insert or rejecting a delete keeps the text; accepting a delete or rejecting an
 * insert removes it. Overlapping marks on removed text go with it; any target-less suggestion
 * whose text is entirely gone is reported as `superseded`. Never mutates `doc`.
 */
export function decideSuggestions(doc: DocNode, op: DecisionOp): DecisionResult {
  const keys = new Set(op.targets.map(targetKey));
  const before = listSuggestions(doc);
  const decided = before
    .filter((i) => keys.has(targetKey(i)))
    .map(({ kind, id }) => ({ kind, id }));
  const content = doc.content.map((block): BlockNode => {
    const inline = inlineOf(block);
    if (!inline) return block;
    const out = transformInline(inline, keys, op.decision);
    const nb = { ...block } as BlockNode & { content?: InlineNode[] };
    if (out.length) nb.content = out;
    else delete nb.content;
    return nb;
  });
  const next: DocNode = { ...doc, content };
  const remaining = new Set(listSuggestions(next).map(targetKey));
  const superseded = before
    .filter((i) => !keys.has(targetKey(i)) && !remaining.has(targetKey(i)))
    .map(({ kind, id }) => ({ kind, id }));
  return { doc: next, decided, superseded };
}

/** Same formula as the .docx importer's note text (paragraph plain text joined by newlines). */
function noteText(content: ParagraphNode[]): string {
  return content
    .map((p) =>
      (p.content ?? [])
        .map((n) => (n.type === 'text' ? n.text : n.type === 'hard_break' ? '\n' : ''))
        .join(''),
    )
    .join('\n')
    .trim();
}

function sameMarks(a: Mark[] | undefined, b: Mark[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

export interface RunOutcome extends PortResult {
  /** Records the sink failed to write; handed to `reconcile` so rows don't stay open. */
  unrecorded: DecisionRecord[];
}

/**
 * Run a decision end to end: one op through the trusted port (which reports what it actually
 * decided on the live doc), then the index update. Superseded suggestions are recorded as
 * rejected. If the sink throws, the records are passed to `reconcile` (e.g. queue a retry or
 * rebuild the index from the CRDT) and returned as `unrecorded`.
 */
export async function runDecision(
  items: SuggestionItem[],
  scope: DecisionScope,
  decision: Decision,
  ctx: {
    tx: ReviewTransactionPort;
    /** Required: every decision must reach the suggestion index (or `reconcile`). */
    sink: SuggestionDecisionSink;
    reconcile?: (records: DecisionRecord[], error: unknown) => void | Promise<void>;
    decidedBy: string;
    now?: () => Date;
  },
): Promise<RunOutcome> {
  const targets = selectTargets(items, scope);
  if (!targets.length) return { decided: [], superseded: [], unrecorded: [] };
  const res = await ctx.tx.applyReviewDecision({ targets, decision });
  const decidedAt = (ctx.now?.() ?? new Date()).toISOString();
  const status = decision === 'accept' ? 'accepted' : 'rejected';
  const records: DecisionRecord[] = [
    ...res.decided.map((t) => ({ ...t, status, decidedAt, decidedBy: ctx.decidedBy }) as const),
    ...res.superseded.map(
      (t) => ({ ...t, status: 'rejected', decidedAt, decidedBy: ctx.decidedBy }) as const,
    ),
  ];
  if (!records.length) return { ...res, unrecorded: [] };
  try {
    await ctx.sink.recordDecisions(records);
    return { ...res, unrecorded: [] };
  } catch (error) {
    await ctx.reconcile?.(records, error);
    return { ...res, unrecorded: records };
  }
}
