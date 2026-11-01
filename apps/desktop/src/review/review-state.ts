/**
 * Review step-through state (RAD-258, board WP 8). Pure helpers: the "Show changes from"
 * single-select view, Previous/Next over visible changes in document order, and a decision log
 * that stays consistent with the document across undo/redo.
 *
 * Everything is keyed on the raw author id from the suggestion mark (never a display name), so
 * two collaborators with the same label are still filtered and decided separately.
 */
import {
  targetKey,
  formatChangeSummary,
  type DecisionRecord,
  type SuggestionItem,
  type SuggestionTarget,
} from '@swarmdraft/editor';

/** Raw author ids in first-appearance (document) order. */
export function authorsOf(items: readonly { author: string }[]): string[] {
  return [...new Set(items.map((i) => i.author))];
}

/** `null` means All (the default); otherwise the single selected author id (#177). */
export type AuthorFilter = string | null;

export function visibleItems<T extends { author: string }>(
  items: readonly T[],
  filter: AuthorFilter,
): T[] {
  return filter ? items.filter((i) => i.author === filter) : [...items];
}

/** True when inline suggestion marks for this author should show (matches panel view). */
export function authorVisibleInFilter(filter: AuthorFilter, author: string): boolean {
  return filter ? author === filter : true;
}

/** Select All (`null`) or one author; clicking the active author again returns to All. */
export function selectAuthorView(current: AuthorFilter, author: string | null): AuthorFilter {
  if (author === null || author === current) return null;
  return author;
}

/** View order for cycling: All, then each author in document order. */
export function authorViewSequence(authors: readonly string[]): readonly (string | null)[] {
  return [null, ...authors];
}

export function cycleAuthorView(
  authors: readonly string[],
  current: AuthorFilter,
  dir: 1 | -1,
): AuthorFilter {
  const seq = authorViewSequence(authors);
  const i = seq.indexOf(current);
  const at = i >= 0 ? i : 0;
  return seq[(at + dir + seq.length) % seq.length]!;
}

export function pendingCountForAuthor(
  items: readonly { author: string; outdated?: boolean }[],
  author: string,
): number {
  return items.filter((c) => c.author === author && !c.outdated).length;
}

type ItemWithOutdated = SuggestionItem & { outdated?: boolean };

export function outdatedCountForAuthor(items: readonly ItemWithOutdated[], author: string): number {
  return items.filter((i) => i.author === author && i.outdated).length;
}

/** Polite live-region copy when the scoped view changes (#177). */
export function viewScopeAnnouncement(
  filter: AuthorFilter,
  displayName: string,
  count: number,
): string {
  if (!filter) return `Showing ${count} change${count === 1 ? '' : 's'} from everyone`;
  return `Showing ${count} change${count === 1 ? '' : 's'} from ${displayName}`;
}

export function bulkActionLabel(
  decision: 'accept' | 'reject',
  filter: AuthorFilter,
  displayName: string,
): string {
  const verb = decision === 'accept' ? 'Accept all' : 'Reject all';
  return filter ? `${verb} from ${displayName}` : verb;
}

export const REVIEW_VIEW_CYCLE = { next: 'Alt+]', prev: 'Alt+[' } as const;

export function reviewViewCycleFor(e: KeyboardEvent): 1 | -1 | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  if (e.key === ']') return 1;
  if (e.key === '[') return -1;
  return null;
}

export const keyOf = (t: SuggestionTarget) => targetKey(t);

/**
 * One reviewable change: an insert, a delete, or a replacement (a delete and an insert that share
 * a suggestion id and author). Deciding it decides every part.
 */
export interface ReviewChange {
  key: string;
  id: string;
  author: string;
  del?: string;
  ins?: string;
  /** Format suggestion summary for the card (#160). */
  format?: { target: string; before: string; after: string; label: string };
  /** Bot rationale shown on the review card (#60). */
  reason?: string;
  /** Index-only outdated row (#179); Dismiss only in the panel. */
  outdated?: boolean;
  targets: SuggestionTarget[];
}

function mergeReason(existing: string | undefined, next: string | undefined): string | undefined {
  const n = next?.trim();
  if (!n) return existing?.trim() || undefined;
  const e = existing?.trim();
  if (!e) return n;
  if (e === n || e.includes(n)) return e;
  if (n.includes(e)) return n;
  return `${e} ${n}`;
}

export function groupChanges(items: readonly SuggestionItem[]): ReviewChange[] {
  const out = new Map<string, ReviewChange>();
  for (const i of items) {
    const key = `${i.author}\u0000${i.id}`;
    let c = out.get(key);
    if (!c) out.set(key, (c = { key, id: i.id, author: i.author, targets: [] }));
    c.targets.push({ kind: i.kind, id: i.id });
    if (i.kind === 'format_change' && i.target != null && i.before != null && i.after != null) {
      c.format = {
        target: i.target,
        before: i.before,
        after: i.after,
        label: formatChangeSummary(i.target, i.before, i.after),
      };
    } else if (i.kind === 'suggestion_delete') c.del = (c.del ?? '') + i.text;
    else if (i.kind === 'suggestion_insert') c.ins = (c.ins ?? '') + i.text;
    if (i.outdated) c.outdated = true;
    c.reason = mergeReason(c.reason, i.reason);
  }
  return [...out.values()];
}

/** Raw ids from agents are prefixed `agent:`; everyone else is a person. */
export const authorKind = (author: string): 'Bot' | 'Person' =>
  author.startsWith('agent:') ? 'Bot' : 'Person';

/** Attach bot rationales from section review meta, keyed by suggestion id (#60). */
export function withSuggestionReasons(
  items: readonly SuggestionItem[],
  reasons: Readonly<Record<string, string>> | undefined,
): SuggestionItem[] {
  return items.map((i) => {
    const fromMeta = reasons?.[i.id]?.trim();
    const base: SuggestionItem = {
      id: i.id,
      kind: i.kind,
      author: i.author,
      ts: i.ts,
      text: i.text,
    };
    return fromMeta ? { ...base, reason: fromMeta } : base;
  });
}

/**
 * Index of the next current change after `current` is gone or moved: the same key if still
 * visible, otherwise the change now at the old position (auto-advance), clamped.
 */
export function resolveCurrent(
  visible: readonly { key: string }[],
  currentKey: string | null,
  fallbackIndex: number,
): number {
  if (!visible.length) return -1;
  if (currentKey) {
    const i = visible.findIndex((v) => v.key === currentKey);
    if (i >= 0) return i;
  }
  return Math.min(Math.max(fallbackIndex, 0), visible.length - 1);
}

export function step(len: number, index: number, dir: 1 | -1): number {
  if (!len) return -1;
  if (index < 0) return dir === 1 ? 0 : len - 1;
  return (index + dir + len) % len;
}

/**
 * Decision records that mirror the document. `record` adds the records of a decision just made;
 * `sync` is called with the suggestions currently in the document after every change: a decided
 * suggestion that is back (undo) has its record withdrawn, and one that goes away again (redo)
 * gets it back. So the log never claims a decision the screen does not show.
 */
export class DecisionLog {
  private active = new Map<string, DecisionRecord>();
  private withdrawn = new Map<string, DecisionRecord>();

  record(records: readonly DecisionRecord[]): void {
    for (const r of records) {
      const k = keyOf(r);
      this.withdrawn.delete(k);
      this.active.set(k, r);
    }
  }

  /** Hydrate from storage after reload; does not emit. */
  restore(records: readonly DecisionRecord[]): void {
    this.active.clear();
    this.withdrawn.clear();
    this.record(records);
  }

  /** Returns true when the log changed. */
  sync(open: readonly SuggestionTarget[]): boolean {
    const present = new Set(open.map(keyOf));
    let changed = false;
    for (const [k, r] of this.active)
      if (present.has(k)) {
        this.active.delete(k);
        this.withdrawn.set(k, r);
        changed = true;
      }
    for (const [k, r] of this.withdrawn)
      if (!present.has(k)) {
        this.withdrawn.delete(k);
        this.active.set(k, r);
        changed = true;
      }
    return changed;
  }

  records(): DecisionRecord[] {
    return [...this.active.values()];
  }
}

/** Collapsed state of the panel persists per device. */
export const REVIEW_COLLAPSED_KEY = 'coauthor.review.collapsed';
export function loadCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(REVIEW_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}
export function saveCollapsed(v: boolean): void {
  try {
    globalThis.localStorage?.setItem(REVIEW_COLLAPSED_KEY, v ? '1' : '0');
  } catch {
    // Storage unavailable: it just opens expanded next launch.
  }
}

/** RAD-258 shortcuts. None use Ctrl+R or Ctrl+J. */
export type ReviewAction = 'next' | 'prev' | 'accept' | 'reject' | 'toggle';
export const REVIEW_SHORTCUTS: Record<ReviewAction, string> = {
  next: 'Alt+Shift+Right',
  prev: 'Alt+Shift+Left',
  accept: 'Ctrl+Shift+Enter',
  reject: 'Ctrl+Shift+Backspace',
  toggle: 'Ctrl+\\',
};
/**
 * True when focus is in a text field or editable region other than the manuscript editor, where
 * review shortcuts must not fire.
 */
export function inForeignInput(target: EventTarget | null, editorRoot: Element | null): boolean {
  if (!(target instanceof Element)) return false;
  if (editorRoot && editorRoot.contains(target)) return false;
  if (target.closest('input, textarea, select')) return true;
  const editable = target.closest('[contenteditable]');
  return !!editable && editable.getAttribute('contenteditable') !== 'false';
}

export function reviewActionFor(e: KeyboardEvent): ReviewAction | null {
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.altKey && e.shiftKey && !ctrl) {
    if (e.key === 'ArrowRight') return 'next';
    if (e.key === 'ArrowLeft') return 'prev';
  }
  if (ctrl && e.shiftKey && !e.altKey) {
    if (e.key === 'Enter') return 'accept';
    if (e.key === 'Backspace') return 'reject';
  }
  if (ctrl && !e.shiftKey && !e.altKey && (e.key === '\\' || e.code === 'Backslash'))
    return 'toggle';
  return null;
}

/** Number of `--ct-collab-N` tokens in tokens.css (light and dark). */
export const COLLAB_TOKENS = 8;
