import type { InjectionKey } from 'vue';
import { parseBookChangeKey, scopeBookChangeKey } from './review/review-book';

export type ContinuousReviewNav = {
  /** Scroll the manuscript column to a book-scoped change and select it (#213). */
  focusChangeId?: (sectionId: string, changeId: string) => Promise<void>;
  navigateToChange: (
    scopedKey: string,
    opts?: { follow?: boolean; suppressSync?: boolean; focusEditor?: boolean },
  ) => Promise<void>;
  /** Pause manuscript→list sync after list-driven scroll (#217). */
  beginSuppressSync: (ms?: number) => void;
  decideInSection: (
    sectionId: string,
    changeKey: string,
    decision: import('@swarmdraft/editor').Decision,
  ) => void;
};

export const CONTINUOUS_REVIEW_NAV: InjectionKey<ContinuousReviewNav> =
  Symbol('continuous-review-nav');

/** Book-scoped key for a change id, with the author when the mark is on the page. */
export function scopedKeyForChange(
  sectionId: string,
  changeId: string,
  author: string | null,
): string {
  const local = author ? `${author}\u0000${changeId}` : changeId;
  return scopeBookChangeKey(sectionId, local);
}

/** True when a stored review key is the requested change, including `author\\0id`. */
export function changeKeyMatches(storedKey: string, requested: string): boolean {
  if (!storedKey || !requested) return false;
  if (storedKey === requested) return true;
  const storedLocal = parseBookChangeKey(storedKey)?.changeKey ?? storedKey;
  const requestedLocal = parseBookChangeKey(requested)?.changeKey ?? requested;
  if (storedLocal === requestedLocal) return true;
  const idOf = (key: string) =>
    key.includes('\u0000') ? key.slice(key.indexOf('\u0000') + 1) : key;
  const storedId = idOf(storedLocal);
  const requestedId = idOf(requestedLocal);
  return storedId.length > 0 && storedId === requestedId;
}

export const CONTINUOUS_SCROLL_ROOT: InjectionKey<{
  root: import('vue').ShallowRef<HTMLElement | null>;
}> = Symbol('continuous-scroll-root');
