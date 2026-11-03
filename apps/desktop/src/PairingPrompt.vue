<script setup lang="ts">
/**
 * Global MCP pairing approval (#188, #269): one dialog lists all pending requests.
 */
import { isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { errorLine, rawErrorText } from './errors/map-error';
import type { Agent } from './backend';
import { pairingApi, type PairingApi, type PairingSummary } from './pairing-client';
import { pairingAccessChips } from './pairing-copy';
import { pairingNameCollisionMessage } from './pairing-errors';
import { trapTab } from './settings/focus-trap';
import { APP_OVERLAY_LAYER } from './overlay/layer';
import './settings/settings.css';

const props = withDefaults(
  defineProps<{
    api?: PairingApi;
    contextManuscriptId?: string | null;
    subscribePairingRequested?: (cb: (pairingId: string) => void) => () => void;
  }>(),
  { api: () => pairingApi, contextManuscriptId: null, subscribePairingRequested: undefined },
);

const emit = defineEmits<{
  approved: [agent: Agent];
}>();

const queue = ref<PairingSummary[]>([]);
const busyId = ref<string | null>(null);
const bulkBusy = ref(false);
const inlineError = ref('');
const dialog = ref<HTMLElement | null>(null);
const denyAllButton = ref<HTMLButtonElement | null>(null);
let opener: HTMLElement | null = null;
let stopPairingListen = () => {};

function pairingGone(err: unknown): boolean {
  const t = rawErrorText(err).toLowerCase();
  return t.includes('not found') || t.includes('no longer pending') || t.includes('expired');
}

function mapPairingError(err: unknown): string {
  return pairingNameCollisionMessage(err) ?? errorLine(err);
}

async function syncQueue() {
  try {
    queue.value = await props.api.listPending();
  } catch (e) {
    console.error('List pending pairings failed', e);
  }
}

async function afterQueueChange() {
  inlineError.value = '';
  if (queue.value.length) {
    await nextTick();
    const focusEl =
      queue.value.length === 1
        ? dialog.value?.querySelector<HTMLButtonElement>('[data-test="pairing-deny"]')
        : denyAllButton.value;
    focusEl?.focus();
    return;
  }
  if (opener?.isConnected) {
    await nextTick();
    opener.focus();
  }
  opener = null;
}

async function onDenied(id: string) {
  if (busyId.value || bulkBusy.value) return;
  busyId.value = id;
  inlineError.value = '';
  try {
    await props.api.deny(id);
    await syncQueue();
    await afterQueueChange();
  } catch (e) {
    console.error('Deny pairing failed', e);
    if (pairingGone(e)) {
      await syncQueue();
      await afterQueueChange();
      return;
    }
    inlineError.value = mapPairingError(e);
  } finally {
    busyId.value = null;
  }
}

async function onAllowed(id: string) {
  if (busyId.value || bulkBusy.value) return;
  const row = queue.value.find((p) => p.id === id);
  if (!row) return;
  busyId.value = id;
  inlineError.value = '';
  try {
    const agent = await props.api.approve(id, row.requestedScopes, props.contextManuscriptId);
    emit('approved', agent);
    await syncQueue();
    await afterQueueChange();
  } catch (e) {
    console.error('Approve pairing failed', e);
    if (pairingGone(e)) {
      await syncQueue();
      await afterQueueChange();
      return;
    }
    inlineError.value = mapPairingError(e);
  } finally {
    busyId.value = null;
  }
}

async function denyAll() {
  if (bulkBusy.value || busyId.value || !queue.value.length) return;
  bulkBusy.value = true;
  inlineError.value = '';
  const ids = queue.value.map((p) => p.id);
  try {
    for (const id of ids) await props.api.deny(id);
    await syncQueue();
    await afterQueueChange();
  } catch (e) {
    inlineError.value = mapPairingError(e);
    await syncQueue();
  } finally {
    bulkBusy.value = false;
  }
}

async function allowAll() {
  if (bulkBusy.value || busyId.value || !queue.value.length) return;
  bulkBusy.value = true;
  inlineError.value = '';
  try {
    for (const row of [...queue.value]) {
      const agent = await props.api.approve(row.id, row.requestedScopes, props.contextManuscriptId);
      emit('approved', agent);
    }
    await syncQueue();
    await afterQueueChange();
  } catch (e) {
    inlineError.value = mapPairingError(e);
    await syncQueue();
  } finally {
    bulkBusy.value = false;
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    void denyAll();
  } else if (dialog.value) trapTab(e, dialog.value);
}

function accessChips(scopes: string[]) {
  return pairingAccessChips(scopes);
}

watch(
  () => queue.value.length,
  async (n, prev) => {
    if (n > 0 && prev === 0) {
      const activeEl = document.activeElement;
      opener = activeEl instanceof HTMLElement ? activeEl : null;
      await afterQueueChange();
    }
  },
);

onMounted(async () => {
  await syncQueue();
  if (queue.value.length) {
    const activeEl = document.activeElement;
    opener = activeEl instanceof HTMLElement ? activeEl : null;
    await afterQueueChange();
  }

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
  <Teleport :to="APP_OVERLAY_LAYER">
    <div v-if="queue.length" class="st-dlg-scrim" data-test="pairing-scrim">
      <div
        ref="dialog"
        class="st-dlg pair-batch"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="pair-title"
        aria-describedby="pair-body pair-hint"
        data-test="pairing-dialog"
        @keydown="onKeydown"
      >
        <h2 id="pair-title" class="st-h2 pair__title">
          {{
            queue.length === 1
              ? `Allow ${queue[0]!.name} to connect?`
              : `Allow ${queue.length} bots to connect?`
          }}
        </h2>
        <p id="pair-body" class="st-desc pair__body">
          Bots on this computer are asking to pair over MCP. Each gets a key with the access shown.
          You can revoke keys later in Settings › Agents.
        </p>
        <ul class="pair__list">
          <li
            v-for="p in queue"
            :key="p.id"
            class="pair__row"
            data-test="pairing-row"
            :data-pairing-id="p.id"
          >
            <div class="pair__head">
              <span class="pair__swatch" aria-hidden="true" :style="{ background: p.color }" />
              <bdi class="pair__name" dir="auto">{{ p.name }}</bdi>
            </div>
            <ul class="pair__chips">
              <li v-for="chip in accessChips(p.requestedScopes)" :key="chip">{{ chip }}</li>
            </ul>
            <div class="pair__row-actions">
              <button
                type="button"
                class="st-btn pair__row-btn"
                :data-test="queue.length === 1 ? 'pairing-deny' : `pairing-deny-${p.id}`"
                :disabled="!!busyId || bulkBusy"
                @click="onDenied(p.id)"
              >
                Deny
              </button>
              <button
                type="button"
                class="st-btn st-btn--primary pair__row-btn"
                :data-test="queue.length === 1 ? 'pairing-allow' : `pairing-allow-${p.id}`"
                :disabled="!!busyId || bulkBusy"
                @click="onAllowed(p.id)"
              >
                Allow
              </button>
            </div>
          </li>
        </ul>
        <p id="pair-hint" class="st-muted pair__hint">
          Esc denies all pending requests. Focus returns to the app when the queue is empty.
        </p>
        <p v-if="inlineError" class="pair__error" role="alert" data-test="pairing-error">
          {{ inlineError }}
        </p>
        <div v-if="queue.length > 1" class="pair__actions">
          <button
            ref="denyAllButton"
            type="button"
            class="st-btn"
            data-test="pairing-deny-all"
            :disabled="!!busyId || bulkBusy"
            @click="denyAll()"
          >
            Deny all
          </button>
          <button
            type="button"
            class="st-btn st-btn--primary"
            data-test="pairing-allow-all"
            :disabled="!!busyId || bulkBusy"
            @click="allowAll()"
          >
            Allow all
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.pair-batch {
  max-width: 28rem;
}
.pair__title {
  margin: 0 0 var(--ct-space-2);
}
.pair__body {
  margin: 0;
}
.pair__list {
  margin: var(--ct-space-3) 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-2);
}
.pair__row {
  padding: var(--ct-space-2) var(--ct-space-3);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-md);
  background: var(--ct-bg);
}
.pair__head {
  display: flex;
  align-items: center;
  gap: var(--ct-space-2);
  margin-bottom: var(--ct-space-1);
}
.pair__swatch {
  flex: none;
  width: var(--ct-space-6);
  height: var(--ct-space-6);
  border-radius: var(--ct-radius-full);
  border: 1px solid var(--ct-border-strong);
}
.pair__name {
  font-weight: var(--ct-weight-semibold);
  font-size: var(--ct-text-sm);
}
.pair__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ct-space-1);
  margin: 0 0 var(--ct-space-2);
  padding: 0;
  list-style: none;
}
.pair__chips li {
  padding: 0 var(--ct-space-2);
  border: 1px solid var(--ct-border-strong);
  border-radius: var(--ct-radius-full);
  background: var(--ct-surface);
  font-size: var(--ct-text-xs);
  line-height: 1.6;
}
.pair__row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ct-space-2);
  justify-content: flex-end;
}
.pair__row-btn {
  min-height: var(--ct-space-8);
  padding: var(--ct-space-1) var(--ct-space-3);
  font-size: var(--ct-text-sm);
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
  margin-top: var(--ct-space-4);
}
</style>
