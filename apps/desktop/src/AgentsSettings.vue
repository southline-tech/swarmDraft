<script setup lang="ts">
/** Settings → Agents (RAD-205): create agents, mint tokens (shown once), revoke. */
import { onMounted, ref } from 'vue';
import {
  AGENT_SCOPES,
  agentsApi,
  type Agent,
  type AgentScope,
  type AgentsApi,
  type TokenInfo,
} from './backend';

const props = withDefaults(defineProps<{ api?: AgentsApi }>(), { api: () => agentsApi });

const agents = ref<Agent[]>([]);
const tokens = ref<Record<string, TokenInfo[]>>({});
const name = ref('Grok Bot');
const color = ref('#3366ff');
const scopes = ref<AgentScope[]>([...AGENT_SCOPES]);
const shownToken = ref<{ agentId: string; token: string } | null>(null);
const error = ref('');

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

onMounted(() => guard(refresh));
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
      <code>{{ shownToken.token }}</code>
      <button type="button" @click="shownToken = null">Done</button>
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
.token-once code {
  display: block;
  user-select: all;
  word-break: break-all;
}
.error {
  color: #b00020;
}
</style>
