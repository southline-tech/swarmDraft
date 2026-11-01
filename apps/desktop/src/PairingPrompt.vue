<script setup lang="ts">
/**
 * Global MCP pairing approval dialog (#188 ap1). One request at a time; tokens never shown.
 */
import { isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { errorLine, rawErrorText } from './errors/map-error';
import type { Agent } from './backend';
import { pairingApi, type PairingApi, type PairingSummary } from './pairing-client';
import { pairingAccessChips } from './pairing-copy';
import { trapTab } from './settings/focus-trap';
import './settings/settings.css';

const props = withDefaults(
  defineProps<{
    api?: PairingApi;
    /** Active draft when pairing is approved (#244); grants that draft only. */
    contextManuscriptId?: string | null;
    /** Test hook: subscribe to pairing-requested instead of Tauri events. */
    subscribePairingRequested?: (cb: (pairingId: string) => void) => () => void;
  }>(),
  { api: () => pairingApi, contextManuscriptId: null, subscribePairingRequested: undefined },
);

const emit = defineEmits<{
  approved: [agent: Agent];
}>();

const queue = ref<PairingSummary[]>([]);
const busy = ref(false);
const inlineError = ref('');
const dialog = ref<HTMLElement | null>(null);
const denyButton = ref<HTMLButtonElement | null>(null);
let opener: HTMLElement | null = null;
let stopPairingListen = () => {};
let showing = false;

const active = () => queue.value[0] ?? null;

function pairingGone(err: unknown): boolean {
  const t = rawErrorText(err).toLowerCase();
  return t.includes('not found') || t.includes('no longer pending') || t.includes('expired');
}

async function syncQueue() {
  try {
    queue.value = await props.api.listPending();
  } catch (e) {
    console.error('List pending pairings failed', e);
  }
}

async function showNext() {
  const cur = active();
  if (!cur || showing) return;
  showing = true;
  inlineError.value = '';
  const activeEl = document.activeElement;
  opener = activeEl instanceof HTMLElement ? activeEl : null;
  await nextTick();
  denyButton.value?.focus();
}

async function afterResolved() {
  busy.value = false;
  showing = false;
  inlineError.value = '';
  await syncQueue();
  if (queue.value.length) {
    await showNext();
    return;
  }
  if (opener?.isConnected) {
    await nextTick();
    opener.focus();
  }
  opener = null;
}

async function onDenied() {
  const cur = active();
  if (!cur || busy.value) return;
  busy.value = true;
  inlineError.value = '';
  try {
    await props.api.deny(cur.id);
    await afterResolved();
  } catch (e) {
    console.error('Deny pairing failed', e);
    if (pairingGone(e)) {
      await afterResolved();
      return;
    }
    inlineError.value = errorLine(e);
    busy.value = false;
  }
}

async function onAllowed() {
  const cur = active();
  if (!cur || busy.value) return;
  busy.value = true;
  inlineError.value = '';
  try {
    const agent = await props.api.approve(cur.id, cur.requestedScopes, props.contextManuscriptId);
    emit('approved', agent);
    await afterResolved();
  } catch (e) {
    console.error('Approve pairing failed', e);
    if (pairingGone(e)) {
      await afterResolved();
      return;
    }
    inlineError.value = errorLine(e);
    busy.value = false;
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    void onDenied();
  } else if (dialog.value) trapTab(e, dialog.value);
}

function accessChips(scopes: string[]) {
  return pairingAccessChips(scopes);
}

watch(
  () => queue.value[0]?.id,
  async (id) => {
    if (id) await showNext();
  },
);

onMounted(async () => {
  await syncQueue();
  if (queue.value.length) await showNext();

  if (props.subscribePairingRequested) {
    stopPairingListen = props.subscribePairingRequested(() => {
      void syncQueue();
    });
    return;
  }
  if (!isTauri()) return;
  let unlisten: UnlistenFn = () => {};
  unlisten = await listen<{ pairingId: string }>('pairing-requested', () => {
    void syncQueue();
  });
  stopPairingListen = () => unlisten();
});

onBeforeUnmount(() => {
  stopPairingListen();
});
</script>

<template>
  <div v-if="active()" class="st-dlg-scrim" data-test="pairing-scrim">
    <div
      ref="dialog"
      class="st-dlg"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="pair-title"
      aria-describedby="pair-body pair-hint"
      data-test="pairing-dialog"
      @keydown="onKeydown"
    >
      <div class="pair__head">
        <span class="pair__swatch" aria-hidden="true" :style="{ background: active()!.color }" />
        <h2 id="pair-title" class="st-h2 pair__title">
          Allow <bdi dir="auto">{{ active()!.name }}</bdi> to connect?
        </h2>
      </div>
      <p id="pair-body" class="st-desc pair__body">
        A bot on this computer is asking to pair over MCP. It will get a key with the access below.
        You can revoke it later in Settings › Agents.
      </p>
      <div class="pair__access">
        <span class="pair__access-label">Requested access</span>
        <ul class="pair__chips">
          <li v-for="chip in accessChips(active()!.requestedScopes)" :key="chip">
            {{ chip }}
          </li>
        </ul>
      </div>
      <p id="pair-hint" class="st-muted pair__hint">
        Esc denies and dismisses. Focus returns to the app.
      </p>
      <p v-if="inlineError" class="pair__error" role="alert" data-test="pairing-error">
        {{ inlineError }}
      </p>
      <div class="pair__actions">
        <button
          ref="denyButton"
          type="button"
          class="st-btn"
          data-test="pairing-deny"
          :disabled="busy"
          @click="onDenied"
        >
          Deny
        </button>
        <button
          type="button"
          class="st-btn st-btn--primary"
          data-test="pairing-allow"
          :disabled="busy"
          @click="onAllowed"
        >
          Allow
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pair__head {
  display: flex;
  align-items: center;
  gap: var(--ct-space-3);
  margin-bottom: var(--ct-space-2);
}
.pair__swatch {
  flex: none;
  width: var(--ct-space-8);
  height: var(--ct-space-8);
  border-radius: var(--ct-radius-full);
  border: 1px solid var(--ct-border-strong);
}
.pair__title {
  margin: 0;
}
.pair__body {
  margin: 0;
}
.pair__access {
  margin-top: var(--ct-space-4);
}
.pair__access-label {
  display: block;
  margin-bottom: var(--ct-space-2);
  font-size: var(--ct-text-sm);
  font-weight: var(--ct-weight-semibold);
}
.pair__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ct-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.pair__chips li {
  padding: var(--ct-space-1) var(--ct-space-3);
  border: 1px solid var(--ct-border-strong);
  border-radius: var(--ct-radius-full);
  background: var(--ct-bg);
  font-size: var(--ct-text-sm);
  font-weight: var(--ct-weight-semibold);
}
.pair__hint {
  margin: var(--ct-space-4) 0 0;
  font-size: var(--ct-text-sm);
}
.pair__error {
  margin: var(--ct-space-3) 0 0;
  color: var(--ct-danger);
  font-size: var(--ct-text-sm);
}
.pair__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ct-space-3);
  margin-top: var(--ct-space-6);
}
</style>
