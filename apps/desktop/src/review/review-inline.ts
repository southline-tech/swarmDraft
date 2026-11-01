/**
 * Mixed review list (#239): document-ordered suggestions and comment threads in one panel.
 */
import type { CommentThread } from '@swarmdraft/editor';
import { parseBookChangeKey, type BookChapterGroup } from './review-book';
import { type AuthorFilter, type ReviewChange, visibleItems } from './review-state';

export const COMMENT_REVIEW_PREFIX = 'comment:';

export function commentReviewKey(threadId: string): string {
  return `${COMMENT_REVIEW_PREFIX}${threadId}`;
}

export function isCommentReviewKey(key: string): boolean {
  return key.startsWith(COMMENT_REVIEW_PREFIX);
}

export function threadIdFromCommentReviewKey(key: string): string | null {
  return isCommentReviewKey(key) ? key.slice(COMMENT_REVIEW_PREFIX.length) : null;
}

export interface ReviewListSuggestion {
  kind: 'suggestion';
  key: string;
  from: number;
  change: ReviewChange;
}

export interface ReviewListComment {
  kind: 'comment';
  key: string;
  from: number;
  thread: CommentThread;
}

export type ReviewListItem = ReviewListSuggestion | ReviewListComment;

const ORPHAN_SORT = Number.MAX_SAFE_INTEGER;

function sortItems(a: ReviewListItem, b: ReviewListItem): number {
  const fa = a.from >= 0 ? a.from : ORPHAN_SORT;
  const fb = b.from >= 0 ? b.from : ORPHAN_SORT;
  if (fa !== fb) return fa - fb;
  if (a.kind !== b.kind) return a.kind === 'suggestion' ? -1 : 1;
  return a.key.localeCompare(b.key);
}

export function buildReviewList(input: {
  changes: readonly ReviewChange[];
  threads: readonly CommentThread[];
  filter: AuthorFilter;
  showResolved: boolean;
  fromOfChange: (change: ReviewChange) => number;
  fromOfThread: (thread: CommentThread) => number;
}): ReviewListItem[] {
  const suggestions = visibleItems(input.changes, input.filter).map((change) => ({
    kind: 'suggestion' as const,
    key: change.key,
    from: input.fromOfChange(change),
    change,
  }));

  const comments: ReviewListComment[] = [];
  for (const thread of input.threads) {
    if (thread.orphan === 'no_comments') continue;
    if (thread.resolved && !input.showResolved) continue;
    comments.push({
      kind: 'comment',
      key: commentReviewKey(thread.id),
      from: input.fromOfThread(thread),
      thread,
    });
  }

  return [...suggestions, ...comments].sort(sortItems);
}

export function groupReviewListByChapter(
  items: readonly ReviewListItem[],
  chapterGroups: readonly BookChapterGroup[],
): Array<BookChapterGroup & { items: ReviewListItem[] }> {
  return chapterGroups
    .map((g) => ({
      ...g,
      items: items.filter((item) => parseBookChangeKey(item.key)?.sectionId === g.sectionId),
    }))
    .filter((g) => g.items.length);
}

/** Suggestion-only rows for bulk actions and overlap UI (#239). */
export function suggestionItems(list: readonly ReviewListItem[]): ReviewListSuggestion[] {
  return list.filter((i): i is ReviewListSuggestion => i.kind === 'suggestion');
}

export const SHOW_RESOLVED_KEY = 'coauthor.review.showResolved';

export function loadShowResolved(
  storage: Pick<Storage, 'getItem'> = globalThis.localStorage,
): boolean {
  try {
    return storage?.getItem(SHOW_RESOLVED_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveShowResolved(
  v: boolean,
  storage: Pick<Storage, 'setItem'> = globalThis.localStorage,
): void {
  try {
    storage?.setItem(SHOW_RESOLVED_KEY, v ? '1' : '0');
  } catch {
    /* ignore */
  }
}
