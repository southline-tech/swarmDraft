<script setup lang="ts">
/** Settings → Agents (RAD-205): create agents, mint tokens (shown once), revoke. */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import {
  AGENT_SCOPES,
  agentsApi,
  type Agent,
  type AgentScope,
  type AgentsApi,
  type TokenInfo,
} from './backend';

const props = withDefaults(
  defineProps<{ api?: AgentsApi; writeClipboard?: (text: string) => Promise<void> }>(),
  {
    api: () => agentsApi,
    // The Clipboard API works in the app webview under our CSP (no network involved).
    writeClipboard: () => (text: string) => navigator.clipboard.writeText(text),
  },
);

const agents = ref<Agent[]>([]);
const tokens = ref<Record<string, TokenInfo[]>>({});
const name = ref('Grok Bot');
const color = ref('#3366ff');
const scopes = ref<AgentScope[]>([...AGENT_SCOPES]);
const shownToken = ref<{ agentId: string; token: string } | null>(null);
const error = ref('');
const copied = ref(false);
const copyFailed = ref(false);

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
  }
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

async function guard(fn: () => Promise<void>) {
  error.value = '';
  try {
    await fn();
  } catch (e) {
    error.value = String(e);
  }
}

async function refresh() {
  agents.value = await props.api.list();
  const entries = await Promise.all(
    agents.value.map(async (a) => [a.id, await props.api.tokens(a.id)] as const),
  );
  tokens.value = Object.fromEntries(entries);
}

const create = () =>
  guard(async () => {
    await props.api.create(name.value, color.value);
    await refresh();
  });
const mint = (agentId: string) =>
  guard(async () => {
    const t = await props.api.createToken(agentId, scopes.value);
    copied.value = false;
    copyFailed.value = false;
    shownToken.value = { agentId, token: t.token };
    await refresh();
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

onMounted(() => {
  window.addEventListener('pagehide', clearToken);
  return guard(refresh);
});
onBeforeUnmount(() => {
  window.removeEventListener('pagehide', clearToken);
  clearToken();
});
</script>

<template>
  <section class="agents">
    <h2>Agents</h2>
    <p class="hint">
      Agents connect to the local MCP server with a bearer token. They can read, comment and
      suggest; accepting or rejecting suggestions is always yours.
    </p>
    <form data-test="create-agent" @submit.prevent="create">
      <input v-model="name" aria-label="Agent name" maxlength="64" required />
      <input v-model="color" aria-label="Agent color" type="color" />
      <button type="submit">Add agent</button>
    </form>
    <fieldset>
      <legend>Scopes for new tokens</legend>
      <label v-for="s in AGENT_SCOPES" :key="s">
        <input v-model="scopes" type="checkbox" :value="s" /> {{ s }}
      </label>
    </fieldset>
    <p v-if="error" class="error" data-test="error">{{ error }}</p>
    <div v-if="shownToken" class="token-once" data-test="token-once">
      <strong>Copy this token now. It won't be shown again.</strong>
      <input
        class="token-value"
        data-test="token-value"
        aria-label="New agent token"
        readonly
        spellcheck="false"
        :value="shownToken.token"
        @focus="selectAll"
        @click="selectAll"
      />
      <button type="button" data-test="copy-token" @click="copyToken">Copy</button>
      <span v-if="copied" role="status" data-test="copied">Copied</span>
      <p v-if="copyFailed" class="error" role="alert" data-test="copy-failed">
        Could not copy automatically. The token is selected above; press Ctrl+C to copy it manually.
      </p>
      <button type="button" data-test="token-done" @click="clearToken">Done</button>
    </div>
    <ul>
      <li v-for="a in agents" :key="a.id" data-test="agent">
        <span class="swatch" :style="{ background: a.color }"></span>
        {{ a.name }}
        <em v-if="a.revokedAt">(revoked)</em>
        <template v-else>
          <button type="button" data-test="mint" @click="mint(a.id)">New token</button>
          <button type="button" data-test="revoke-agent" @click="revokeAgent(a.id)">
            Revoke agent
          </button>
        </template>
        <ul>
          <li v-for="t in tokens[a.id] ?? []" :key="t.id" data-test="token">
            <code>{{ t.prefix }}…</code> {{ t.scopes.join(', ') }} · last used
            {{ t.lastUsedAt ?? 'never' }}
            <em v-if="t.revokedAt">(revoked)</em>
            <button v-else type="button" data-test="revoke-token" @click="revokeToken(t.id)">
              Revoke
            </button>
          </li>
        </ul>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.swatch {
  display: inline-block;
  width: 0.8em;
  height: 0.8em;
  border-radius: 50%;
}
.token-value {
  display: block;
  width: 100%;
  font-family: monospace;
  user-select: all;
}
.error {
  color: #b00020;
}
</style>
