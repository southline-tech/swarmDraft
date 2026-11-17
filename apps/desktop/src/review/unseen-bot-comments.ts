/**
 * Session badge for bot comment threads the author has not opened in Review (#339).
 * "Known" threads come from loaded section review meta; "seen" threads are cleared when
 * the author selects that thread in the review list (currentKey) or jumps to it.
 */
import type { CommentRow } from '@swarmdraft/editor';
import { computed, ref, type Ref } from 'vue';

export function botCommentThreadIds(rows: readonly CommentRow[]): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.authorKind !== 'agent') continue;
    if (r.resolvedAt) continue;
    out.add(r.threadId);
  }
  return [...out];
}

export function unseenBotCommentCount(
  knownThreadIds: ReadonlySet<string>,
  seenThreadIds: ReadonlySet<string>,
): number {
  let n = 0;
  for (const id of knownThreadIds) if (!seenThreadIds.has(id)) n++;
  return n;
}

export interface UnseenBotComments {
  unseenCount: Ref<number>;
  ingestRows: (rows: readonly CommentRow[]) => void;
  markThreadSeen: (threadId: string) => void;
  reset: () => void;
}

export function useUnseenBotComments(): UnseenBotComments {
  const known = ref(new Set<string>());
  const seen = ref(new Set<string>());

  const reset = () => {
    known.value = new Set();
    seen.value = new Set();
  };

  const ingestRows = (rows: readonly CommentRow[]) => {
    for (const id of botCommentThreadIds(rows)) known.value.add(id);
  };

  const markThreadSeen = (threadId: string) => {
    if (!threadId || !known.value.has(threadId)) return;
    if (seen.value.has(threadId)) return;
    const next = new Set(seen.value);
    next.add(threadId);
    seen.value = next;
  };

  const unseenCount = computed(() => unseenBotCommentCount(known.value, seen.value));

  return { unseenCount, ingestRows, markThreadSeen, reset };
}
