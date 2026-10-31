<script setup lang="ts">
/**
 * Settings → Agents (RAD-205, #99 layout): create agents, mint keys (shown once), turn keys off.
 * User-facing copy says "key"; code identifiers keep "token".
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { setAgents } from './agent-names';
import { errorLine, rawErrorText } from './errors/map-error';
import { mcpAgentStatus } from './mcp-agent-status';
import {
  AGENT_SCOPES,
  agentsApi,
  type Agent,
  type AgentScope,
  type AgentsApi,
  type TokenInfo,
} from './backend';

const props = withDefaults(
  defineProps<{
    api?: AgentsApi;
    writeClipboard?: (text: string) => Promise<void>;
    /** Test hook instead of Tauri `agents-changed`. */
    subscribeAgentsChanged?: (cb: () => void) => () => void;
    now?: () => number;
  }>(),
  {
    api: () => agentsApi,
    writeClipboard: (text: string) => navigator.clipboard.writeText(text),
    subscribeAgentsChanged: undefined,
    now: () => Date.now(),
  },
);

const agents = ref<Agent[]>([]);
const tokens = ref<Record<string, TokenInfo[]>>({});
const removedOpen = ref(false);
const removedPanelId = 'ag-removed-panel';
const name = ref('Grok Bot');
const color = ref('#3366ff');
const scopes = ref<AgentScope[]>([...AGENT_SCOPES]);
const shownToken = ref<{ agentId: string; token: string; agentName: string } | null>(null);
const error = ref('');
const copied = ref(false);
const copyFailed = ref(false);
const tokenInput = ref<HTMLInputElement | null>(null);

/**
 * Copy the shown token. On failure (clipboard missing, permission denied, webview quirk) the
 * token stays on screen and selectable; it is never hidden or cleared by a failed copy.
 */
async function copyToken() {
  if (!shownToken.value) return;
  copied.value = false;
  copyFailed.value = false;
  try {
    await props.writeClipboard(shownToken.value.token);
    copied.value = true;
  } catch {
    copyFailed.value = true;
    // Focus (and so select) the token, so the "selected above" hint is true.
    await focusKeyCard();
  }
}

/** Move keyboard focus into the one-time key card (Designer #187 ap3 polish). */
async function focusKeyCard() {
  await nextTick();
  tokenInput.value?.focus();
  tokenInput.value?.select();
}

function selectAll(e: Event) {
  (e.target as HTMLInputElement).select();
}

/** The plaintext token only lives in memory until the panel is dismissed or the view goes away. */
function clearToken() {
  shownToken.value = null;
  copied.value = false;
  copyFailed.value = false;
}

// Name and color rule messages from the backend are written for the user; show those as they
// are. Anything else (database, I/O) goes through mapError so raw text never reaches the UI.
const RULE_MESSAGE =
  /^(name must be 1-64 characters|"[^"\n]{1,64}" is reserved; choose another agent name|an agent named "[^"\n]{1,64}" already exists; choose another name|color must look like #rrggbb)$/;

function agentError(e: unknown): string {
  const text = rawErrorText(e);
  return RULE_MESSAGE.test(text) ? text : errorLine(e);
}

async function guard(fn: () => Promise<void>) {
  error.value = '';
  try {
    await fn();
  } catch (e) {
    console.error('Agent settings action failed', e);
    error.value = agentError(e);
  }
}

async function refresh() {
  agents.value = await props.api.list();
  setAgents(agents.value); // names in the editor and review UI follow this list live
  const active = agents.value.filter((a) => !a.revokedAt);
  const entries = await Promise.all(
    active.map(async (a) => [a.id, await props.api.tokens(a.id)] as const),
  );
  tokens.value = Object.fromEntries(entries);
}

const activeAgents = computed(() => agents.value.filter((a) => !a.revokedAt));
const removedAgents = computed(() => agents.value.filter((a) => a.revokedAt));

const REMOVED_HELP =
  'Removed agents stay listed only while they still have suggestions or comments in your books. Name and color stay so old marks keep their attribution.';

/** User-facing "Removed Oct 30" from an ISO revoked_at timestamp (#192). */
function formatRemovedDate(revokedAt: string | null): string {
  if (!revokedAt) return 'Removed';
  const ms = Date.parse(revokedAt);
  if (Number.isNaN(ms)) return 'Removed';
  const label = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(ms);
  return `Removed ${label}`;
}

const create = () =>
  guard(async () => {
    const agent = await props.api.create(name.value, color.value);
    try {
      const t = await props.api.createToken(agent.id, scopes.value);
      copied.value = false;
      copyFailed.value = false;
      shownToken.value = {
        agentId: agent.id,
        token: t.token,
        agentName: agent.name,
      };
      await refresh();
      await focusKeyCard();
    } catch (e) {
      console.error('Agent settings action failed', e);
      error.value = agentError(e);
      await refresh();
    }
  });
const mint = (agentId: string) =>
  guard(async () => {
    const t = await props.api.createToken(agentId, scopes.value);
    copied.value = false;
    copyFailed.value = false;
    const agentName = agents.value.find((a) => a.id === agentId)?.name ?? '';
    shownToken.value = { agentId, token: t.token, agentName };
    await refresh();
    await focusKeyCard();
  });
const revokeToken = (id: string) =>
  guard(async () => {
    await props.api.revokeToken(id);
    await refresh();
  });
const revokeAgent = (id: string) =>
  guard(async () => {
    await props.api.revoke(id);
    await refresh();
  });

const SCOPE_HINT: Record<AgentScope, string> = {
  read: 'see your books',
  comment: 'leave comments',
  suggest: 'propose edits',
};

/** Tick every 30s so relative MCP times stay fresh (#188 ap2). */
const statusTick = ref(0);
let statusTimer: ReturnType<typeof setInterval> | undefined;
let stopAgentsChanged = () => {};

function agentMcpStatus(agent: Agent) {
  void statusTick.value;
  return mcpAgentStatus(agent.lastSeenAt, props.now());
}

onMounted(() => {
  window.addEventListener('pagehide', clearToken);
  void guard(refresh);
  statusTimer = setInterval(() => {
    statusTick.value++;
    void refresh();
  }, 30_000);
  if (props.subscribeAgentsChanged) {
    stopAgentsChanged = props.subscribeAgentsChanged(() => {
      void refresh();
    });
  } else if (isTauri()) {
    let unlisten: UnlistenFn = () => {};
    void listen('agents-changed', () => {
      void refresh();
    }).then((u) => {
      unlisten = u;
    });
    stopAgentsChanged = () => unlisten();
  }
});
onBeforeUnmount(() => {
  window.removeEventListener('pagehide', clearToken);
  clearToken();
  clearInterval(statusTimer);
  stopAgentsChanged();
});
</script>

<template>
  <div class="agents">
    <h1 class="st-h1">Agents</h1>
    <p class="st-muted st-sub">
      Agents are helpers that work on your book through a key you give them. They can read, comment
      and suggest — accepting or rejecting suggestions is always up to you.
    </p>
    <section
      v-if="shownToken"
      class="st-card ag__once"
      aria-labelledby="ag-once"
      data-test="token-once"
    >
      <h2 id="ag-once" class="st-h2">
        New key for <bdi dir="auto">{{ shownToken.agentName }}</bdi>
      </h2>
      <p class="st-desc">
        <b>Copy this key now. This key won't be shown again.</b> Paste it into the agent's setup.
      </p>
      <div class="ag__keyrow">
        <input
          ref="tokenInput"
          class="st-inp st-mono token-value"
          data-test="token-value"
          aria-label="New agent key"
          readonly
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          :value="shownToken.token"
          @focus="selectAll"
          @click="selectAll"
        />
        <button
          type="button"
          class="st-btn st-btn--primary"
          data-test="copy-token"
          @click="copyToken"
        >
          Copy
        </button>
        <span role="status" class="ag__copied">
          <template v-if="copied">
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="m3.5 8.5 3 3 6-7" />
            </svg>
            <span data-test="copied">Copied</span>
          </template>
        </span>
      </div>
      <p v-if="copyFailed" class="ag__error" role="alert" data-test="copy-failed">
        Couldn't copy automatically. The key is selected above; press Ctrl+C to copy it.
      </p>
      <div class="ag__done">
        <button type="button" class="st-btn" data-test="token-done" @click="clearToken">
          Done
        </button>
      </div>
    </section>
    <section class="st-card" aria-labelledby="ag-add">
      <h2 id="ag-add" class="st-h2">Add an agent</h2>
      <form class="ag__form" data-test="create-agent" @submit.prevent="create">
        <input v-model="name" class="st-inp" aria-label="Agent name" maxlength="64" required />
        <input v-model="color" class="ag__color" aria-label="Agent color" type="color" />
        <button type="submit" class="st-btn st-btn--primary">Add agent</button>
      </form>
      <p role="alert" class="ag__error">
        <span v-if="error" data-test="error">{{ error }}</span>
      </p>
      <fieldset class="ag__scopes">
        <legend class="ag__legend">New keys can</legend>
        <label v-for="s in AGENT_SCOPES" :key="s" class="ag__cb">
          <input v-model="scopes" type="checkbox" :value="s" />
          <span
            ><b>{{ s }}</b> <span class="st-muted ag__hint">{{ SCOPE_HINT[s] }}</span></span
          >
        </label>
      </fieldset>
    </section>
    <section class="st-card" aria-labelledby="ag-list">
      <h2 id="ag-list" class="st-h2">Your agents</h2>
      <p v-if="!activeAgents.length && !removedAgents.length" class="st-muted st-desc">
        No agents yet.
      </p>
      <ul class="ag__list">
        <li v-for="a in activeAgents" :key="a.id" class="ag__agent" data-test="agent">
          <div class="ag__head">
            <span class="ag__av" :style="{ background: a.color }" aria-hidden="true">{{
              a.name.charAt(0)
            }}</span>
            <b class="ag__name"
              ><bdi dir="auto">{{ a.name }}</bdi></b
            >
            <p class="ag__mcp" :class="`ag__mcp--${agentMcpStatus(a).tone}`" data-test="mcp-status">
              <span class="ag__mcp-dot" aria-hidden="true" />
              <span>{{ agentMcpStatus(a).text }}</span>
            </p>
            <button type="button" class="st-btn st-btn--s" data-test="mint" @click="mint(a.id)">
              New key
            </button>
            <button
              type="button"
              class="st-btn st-btn--s st-btn--link ag__danger"
              data-test="revoke-agent"
              @click="revokeAgent(a.id)"
            >
              Remove agent
            </button>
          </div>
          <ul class="ag__tokens">
            <li v-for="t in tokens[a.id] ?? []" :key="t.id" class="ag__tok" data-test="token">
              <code class="st-mono">{{ t.prefix }}…</code>
              <span>{{ t.scopes.join(', ') }} · last used {{ t.lastUsedAt ?? 'never' }}</span>
              <span class="ag__sp"></span>
              <em v-if="t.revokedAt">Turned off</em>
              <button
                v-else
                type="button"
                class="st-btn st-btn--s st-btn--link"
                data-test="revoke-token"
                @click="revokeToken(t.id)"
              >
                Turn off key
              </button>
            </li>
          </ul>
        </li>
      </ul>
      <div v-if="removedAgents.length" class="ag__removed">
        <button
          type="button"
          class="ag__removed-toggle"
          data-test="removed-toggle"
          :aria-expanded="removedOpen"
          :aria-controls="removedPanelId"
          @click="removedOpen = !removedOpen"
          @keydown.enter.prevent="removedOpen = !removedOpen"
          @keydown.space.prevent="removedOpen = !removedOpen"
        >
          <span class="ag__removed-chevron" aria-hidden="true">{{ removedOpen ? '▾' : '▸' }}</span>
          Removed agents ({{ removedAgents.length }})
        </button>
        <div v-if="removedOpen" :id="removedPanelId" class="ag__removed-panel">
          <p class="st-muted st-desc ag__removed-help">{{ REMOVED_HELP }}</p>
          <ul class="ag__list ag__list--removed">
            <li
              v-for="a in removedAgents"
              :key="a.id"
              class="ag__agent ag__agent--removed"
              data-test="removed-agent"
            >
              <div class="ag__head">
                <span class="ag__av" :style="{ background: a.color }" aria-hidden="true">{{
                  a.name.charAt(0)
                }}</span>
                <b class="ag__name"
                  ><bdi dir="auto">{{ a.name }}</bdi></b
                >
                <span class="st-muted ag__removed-date">{{ formatRemovedDate(a.revokedAt) }}</span>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.ag__once {
  border: 2px solid var(--ct-accent);
}
.ag__keyrow,
.ag__form {
  display: flex;
  align-items: center;
  gap: var(--ct-space-3);
}
.ag__form {
  margin-top: var(--ct-space-3);
}
.token-value {
  user-select: all;
}
.ag__copied {
  display: inline-flex;
  align-items: center;
  gap: var(--ct-space-1);
  min-width: var(--ct-space-16);
  color: var(--ct-success);
  font-weight: var(--ct-weight-semibold);
}
.ag__copied svg,
.ag__cb svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 2.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.ag__error {
  margin: var(--ct-space-2) 0 0;
  color: var(--ct-danger);
  font-size: var(--ct-text-sm);
}
.ag__error:empty {
  margin: 0;
}
.ag__done {
  margin-top: var(--ct-space-3);
}
.ag__color {
  flex: none;
  width: var(--ct-space-16);
  height: var(--ct-space-12);
  padding: var(--ct-space-1);
  border: 1px solid var(--ct-border-strong);
  border-radius: var(--ct-radius-md);
  background: var(--ct-bg);
  cursor: pointer;
}
.ag__scopes {
  margin: var(--ct-space-3) 0 0;
  padding: 0;
  border: 0;
}
.ag__legend {
  padding: 0;
  margin-bottom: var(--ct-space-1);
  font-size: var(--ct-text-sm);
  font-weight: var(--ct-weight-semibold);
}
.ag__cb {
  display: inline-flex;
  align-items: center;
  gap: var(--ct-space-2);
  min-height: var(--ct-space-12);
  margin-right: var(--ct-space-5);
  cursor: pointer;
}
.ag__cb input {
  width: var(--ct-space-5);
  height: var(--ct-space-5);
  margin: 0;
  accent-color: var(--ct-accent);
}
.ag__hint {
  font-size: var(--ct-text-sm);
}
.ag__list,
.ag__tokens {
  margin: 0;
  padding: 0;
  list-style: none;
}
.ag__agent {
  padding: var(--ct-space-3) 0;
  border-top: 1px solid var(--ct-border);
}
.ag__agent:first-child {
  border-top: 0;
}
.ag__head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--ct-space-3);
}
.ag__mcp {
  display: inline-flex;
  align-items: center;
  gap: var(--ct-space-2);
  flex: 1 1 100%;
  margin: 0;
  padding-left: calc(var(--ct-space-8) + var(--ct-space-3));
  font-size: var(--ct-text-sm);
  color: var(--ct-text-muted);
}
.ag__mcp--connected {
  color: var(--ct-success);
}
.ag__mcp--muted {
  color: var(--ct-text-muted);
}
.ag__mcp-dot {
  width: var(--ct-space-2);
  height: var(--ct-space-2);
  border-radius: var(--ct-radius-full);
  background: var(--ct-text-muted);
}
.ag__mcp--connected .ag__mcp-dot {
  background: var(--ct-success);
}
.ag__av {
  display: grid;
  flex: none;
  place-items: center;
  width: var(--ct-space-8);
  height: var(--ct-space-8);
  border-radius: var(--ct-radius-full);
  color: var(--ct-accent-contrast);
  font-size: var(--ct-text-sm);
  font-weight: var(--ct-weight-semibold);
}
.ag__name {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.ag__danger {
  color: var(--ct-danger);
}
.ag__tok {
  display: flex;
  align-items: center;
  gap: var(--ct-space-3);
  padding: var(--ct-space-1) 0 var(--ct-space-1) var(--ct-space-10);
  color: var(--ct-text-muted);
  font-size: var(--ct-text-sm);
}
.ag__sp {
  flex: 1;
}
.ag__removed {
  margin-top: var(--ct-space-3);
  padding-top: var(--ct-space-3);
  border-top: 1px solid var(--ct-border);
}
.ag__removed-toggle {
  display: flex;
  align-items: center;
  gap: var(--ct-space-2);
  width: 100%;
  padding: var(--ct-space-1) 0;
  border: 0;
  background: none;
  color: var(--ct-text-muted);
  font: inherit;
  font-size: var(--ct-text-sm);
  font-weight: var(--ct-weight-semibold);
  text-align: left;
  cursor: pointer;
}
.ag__removed-toggle:focus-visible {
  outline: 0;
  box-shadow: var(--ct-focus-ring);
  border-radius: var(--ct-radius-sm);
}
.ag__removed-panel {
  margin-top: var(--ct-space-2);
}
.ag__removed-help {
  margin-bottom: var(--ct-space-2);
}
.ag__list--removed .ag__agent--removed {
  border-top-color: var(--ct-border);
}
.ag__agent--removed .ag__head {
  color: var(--ct-text-muted);
}
.ag__removed-date {
  margin-left: auto;
  font-size: var(--ct-text-sm);
  font-style: normal;
}
</style>
