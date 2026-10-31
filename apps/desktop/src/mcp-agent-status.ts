/** Settings › Agents MCP connection row (#188 ap2). Plain text; not live-announced. */

const TWO_MIN_MS = 2 * 60 * 1000;

export type McpStatusTone = 'connected' | 'muted';

export interface McpAgentStatus {
  text: string;
  tone: McpStatusTone;
}

export function mcpAgentStatus(
  lastSeenAt: string | null | undefined,
  nowMs = Date.now(),
): McpAgentStatus {
  if (!lastSeenAt) return { text: 'Not connected', tone: 'muted' };
  const seen = Date.parse(lastSeenAt);
  if (Number.isNaN(seen)) return { text: 'Not connected', tone: 'muted' };
  const ageMs = Math.max(0, nowMs - seen);
  if (ageMs <= TWO_MIN_MS) return { text: 'MCP connected', tone: 'connected' };
  const min = Math.floor(ageMs / 60_000);
  if (min < 60) return { text: `Last active ${min} min ago`, tone: 'muted' };
  const hours = Math.floor(min / 60);
  if (hours < 24) return { text: `Last active ${hours} h ago`, tone: 'muted' };
  const days = Math.floor(hours / 24);
  return { text: `Last active ${days} d ago`, tone: 'muted' };
}
