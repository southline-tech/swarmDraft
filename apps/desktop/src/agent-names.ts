/**
 * Agent display names for the editor and review UI (RAD-263). Review marks and comments store
 * an agent as `agent:<id>`; this maps it to the name from the agents table, live: the
 * directory is reactive, so a rename shows up wherever a label is rendered. Never shows the raw
 * id: a deleted agent reads "Removed agent", an unnamed one "Unnamed agent", a revoked one gets a "(revoked)" note. Labels are plain text and
 * are only ever rendered as text, never as HTML.
 */
import { shallowRef } from 'vue';
import { isTauri } from '@tauri-apps/api/core';
import { agentsApi, type Agent } from './backend';

export const AGENT_PREFIX = 'agent:';
export const REMOVED_AGENT = 'Removed agent';
export const UNNAMED_AGENT = 'Unnamed agent';
export const REVOKED_NOTE = '(revoked)';
export const REMOVED_NOTE = '(removed)';

/** `null` until the agents list has loaded at least once. */
export const agentDirectory = shallowRef<ReadonlyMap<string, Agent> | null>(null);

let reloadSeq = 0;

const apply = (list: readonly Agent[]) => {
  agentDirectory.value = new Map(list.map((a) => [a.id, a]));
};

/** Set the list directly (e.g. from AgentsSettings); any reload already in flight is dropped. */
export function setAgents(list: readonly Agent[]) {
  reloadSeq++;
  apply(list);
}

let inflight: Promise<void> | null = null;

/**
 * Reload the agents list (outside Tauri this is a no-op without `list`). Errors keep the last
 * list; a reply that arrives after a newer reload started is ignored, and concurrent default
 * reloads share one request.
 */
export function refreshAgents(list?: () => Promise<Agent[]>): Promise<void> {
  if (!list && !isTauri()) return Promise.resolve();
  if (!list && inflight) return inflight;
  const seq = ++reloadSeq;
  const run: Promise<void> = (async () => {
    try {
      const agents = await (list ?? agentsApi.list)();
      if (seq === reloadSeq) apply(agents);
    } catch (err) {
      console.error('Could not load agent names', err);
    }
  })();
  if (!list) {
    inflight = run;
    void run.finally(() => {
      if (inflight === run) inflight = null;
    });
  }
  return run;
}

export const FOCUS_RELOAD_MS = 2000;
let lastFocusReload = -Infinity;

/** Window-focus reload, throttled so rapid focus changes make at most one request per window. */
export function reloadOnFocus(now = Date.now(), list?: () => Promise<Agent[]>) {
  if (now - lastFocusReload < FOCUS_RELOAD_MS) return Promise.resolve();
  lastFocusReload = now;
  return refreshAgents(list);
}

/** Test hook: forget throttle and in-flight state. */
export function resetAgentReloads() {
  reloadSeq = 0;
  inflight = null;
  lastFocusReload = -Infinity;
}

export const agentIdOf = (author: string) =>
  author.startsWith(AGENT_PREFIX) ? author.slice(AGENT_PREFIX.length) : undefined;

/** A display name plus an optional note ("(revoked)" / "(removed)") rendered muted. */
export interface AgentName {
  name: string;
  note?: string;
  /** True for agent authors: shown with an "Agent" tag, and "(agent)" in hover text. */
  agent?: boolean;
}

/** Bidi embedding/override/isolate controls and LRM/RLM, which could reorder labels. */
const BIDI_CONTROLS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
export const stripBidi = (s: string) => s.replace(BIDI_CONTROLS, '');

const usable = (saved: string | undefined, id: string) => {
  const t = saved && stripBidi(saved).trim();
  return t && t !== `${AGENT_PREFIX}${id}` && t !== id ? t : undefined;
};

/**
 * Name parts for an agent id. `saved` is a name stored with the item (e.g. a comment's
 * authorName): shown while the directory has not loaded, and as "<saved> (removed)" once the
 * agent is gone.
 */
export function agentName(id: string, saved?: string): AgentName {
  const dir = agentDirectory.value;
  const agent = dir?.get(id);
  if (agent) {
    const name = stripBidi(agent.name).trim() || UNNAMED_AGENT;
    return agent.revokedAt ? { name, note: REVOKED_NOTE, agent: true } : { name, agent: true };
  }
  const kept = usable(saved, id);
  if (dir)
    return kept
      ? { name: kept, note: REMOVED_NOTE, agent: true }
      : { name: REMOVED_AGENT, agent: true };
  return { name: kept ?? UNNAMED_AGENT, agent: true };
}

/** Plain-text form: "Name (agent)", "Name (agent, revoked)"; people as stored. */
export function joinName(n: AgentName): string {
  if (!n.agent || n.name === UNNAMED_AGENT || n.name === REMOVED_AGENT)
    return n.note ? `${n.name} ${n.note}` : n.name;
  const extra = n.note ? `, ${n.note.replace(/[()]/g, '')}` : '';
  return `${n.name} (agent${extra})`;
}

/** Plain-text label for an agent id (used for hover text). */
export const agentLabel = (id: string, saved?: string) => joinName(agentName(id, saved));

/** Name parts for a review mark's `author` attr; non-agent authors are shown as stored. */
export function authorName(author: string | undefined | null): AgentName {
  if (!author) return { name: '' };
  const id = agentIdOf(author);
  return id === undefined ? { name: stripBidi(author) } : agentName(id);
}

/** Plain-text label for a review mark's `author` attr. */
export const authorLabel = (author: string | undefined | null) => joinName(authorName(author));
