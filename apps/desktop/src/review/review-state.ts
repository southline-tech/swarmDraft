/**
 * Review step-through state (RAD-258, board WP 8). Pure helpers: the "Show changes from"
 * filter, Previous/Next over visible changes in document order, and a decision log that stays
 * consistent with the document across undo/redo.
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

/** `null` selection means All (the default). */
export type AuthorFilter = ReadonlySet<string> | null;

export function visibleItems<T extends { author: string }>(
  items: readonly T[],
  filter: AuthorFilter,
): T[] {
  return filter ? items.filter((i) => filter.has(i.author)) : [...items];
}

/** True when inline suggestion marks for this author should show (matches panel filter). */
export function authorVisibleInFilter(filter: AuthorFilter, author: string): boolean {
  return filter ? filter.has(author) : true;
}

/** Trigger label: "All", or "2 of 3". */
export function filterSummary(authors: readonly string[], filter: AuthorFilter): string {
  if (!filter) return 'All';
  const n = authors.filter((a) => filter.has(a)).length;
  return n === authors.length ? 'All' : `${n} of ${authors.length}`;
}

/** Toggle one author; selecting everyone collapses back to All. */
export function toggleAuthor(
  authors: readonly string[],
  filter: AuthorFilter,
  author: string,
): AuthorFilter {
  const next = new Set(filter ?? authors);
  if (next.has(author)) next.delete(author);
  else next.add(author);
  return authors.every((a) => next.has(a)) ? null : next;
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
export const REVIEW_COLLAPSED_KEY = 'swarmdraft.review.collapsed';
const LEGACY_REVIEW_COLLAPSED_KEY = 'coauthor.review.collapsed';
export function loadCollapsed(): boolean {
  try {
    const ls = globalThis.localStorage;
    if (ls?.getItem(REVIEW_COLLAPSED_KEY) === '1') return true;
    if (ls?.getItem(LEGACY_REVIEW_COLLAPSED_KEY) === '1') {
      ls?.setItem(REVIEW_COLLAPSED_KEY, '1');
      return true;
    }
    return false;
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
