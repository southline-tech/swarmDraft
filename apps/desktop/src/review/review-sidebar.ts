import type { CommentRow } from '@coauthor/editor';
import { agentIdOf, agentName, type AgentName } from '../agent-names';

/** First comment row per thread (by createdAt), for review-sidebar author lines. */
export function primaryCommentByThread(rows: readonly CommentRow[]): Map<string, CommentRow> {
  const byThread = new Map<string, CommentRow>();
  for (const row of rows) {
    const cur = byThread.get(row.threadId);
    if (!cur || row.createdAt.localeCompare(cur.createdAt) < 0) byThread.set(row.threadId, row);
  }
  return byThread;
}

export function commentRowLabel(row: CommentRow): AgentName {
  return row.authorKind === 'agent'
    ? agentName(agentIdOf(row.authorId) ?? row.authorId, row.authorName)
    : { name: row.authorName, agent: false };
}
