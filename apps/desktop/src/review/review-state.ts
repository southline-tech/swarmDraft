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
  type DecisionRecord,
  type SuggestionItem,
  type SuggestionTarget,
} from '@coauthor/editor';

/** Raw author ids in first-appearance (document) order. */
export function authorsOf(items: readonly SuggestionItem[]): string[] {
  return [...new Set(items.map((i) => i.author))];
}

/** `null` selection means All (the default). */
export type AuthorFilter = ReadonlySet<string> | null;

export function visibleItems(items: readonly SuggestionItem[], filter: AuthorFilter) {
  return filter ? items.filter((i) => filter.has(i.author)) : [...items];
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
 * Index of the next current change after `current` is gone or moved: the same key if still
 * visible, otherwise the change now at the old position (auto-advance), clamped.
 */
export function resolveCurrent(
  visible: readonly SuggestionItem[],
  currentKey: string | null,
  fallbackIndex: number,
): number {
  if (!visible.length) return -1;
  if (currentKey) {
    const i = visible.findIndex((v) => keyOf(v) === currentKey);
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
