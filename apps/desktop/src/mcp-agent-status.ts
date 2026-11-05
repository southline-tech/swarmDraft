/** Settings › Agents connection row (#188 ap2). Plain text; not live-announced. */
import { agentConnection } from './copy-deck';

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
  if (!lastSeenAt) return { text: agentConnection.notConnected, tone: 'muted' };
  const seen = Date.parse(lastSeenAt);
  if (Number.isNaN(seen)) return { text: agentConnection.notConnected, tone: 'muted' };
  const ageMs = Math.max(0, nowMs - seen);
  if (ageMs <= TWO_MIN_MS) return { text: agentConnection.connected, tone: 'connected' };
  const min = Math.floor(ageMs / 60_000);
  if (min < 60) return { text: agentConnection.lastActiveMin(min), tone: 'muted' };
  const hours = Math.floor(min / 60);
  if (hours < 24) return { text: agentConnection.lastActiveHours(hours), tone: 'muted' };
  const days = Math.floor(hours / 24);
  return { text: agentConnection.lastActiveDays(days), tone: 'muted' };
}
