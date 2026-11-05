<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DraftCommitEntry } from '../backend';
import { draftHistory, draftRestore } from '../backend';

const props = defineProps<{
  open: boolean;
  manuscriptId: string | null;
}>();

const emit = defineEmits<{
  close: [];
  restored: [];
}>();

const commits = ref<DraftCommitEntry[]>([]);
const loading = ref(false);
const error = ref('');
const confirmOid = ref<string | null>(null);
const confirmEntry = computed(() => commits.value.find((c) => c.oid === confirmOid.value));

async function load() {
  if (!props.manuscriptId) return;
  loading.value = true;
  error.value = '';
  try {
    commits.value = await draftHistory(props.manuscriptId, 50, 0);
  } catch (e) {
    console.error('History load failed', e);
    error.value = "Couldn't load history. Try again.";
    commits.value = [];
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.open, props.manuscriptId] as const,
  ([open]) => {
    if (open) void load();
    else confirmOid.value = null;
  },
);

function formatWhen(unix: number) {
  return new Date(unix * 1000).toLocaleString();
}

function askRestore(entry: DraftCommitEntry) {
  confirmOid.value = entry.oid;
}

function cancelRestore() {
  confirmOid.value = null;
}

async function doRestore() {
  if (!props.manuscriptId || !confirmOid.value) return;
  try {
    await draftRestore(props.manuscriptId, confirmOid.value);
    confirmOid.value = null;
    emit('restored');
    await load();
  } catch (e) {
    console.error('Restore failed', e);
    error.value = "Couldn't restore that version.";
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (confirmOid.value) cancelRestore();
    else emit('close');
  }
}
</script>

<template>
  <div
    v-if="open"
    class="history-panel"
    role="dialog"
    aria-labelledby="history-title"
    aria-modal="true"
    data-test="history-panel"
    @keydown="onKeydown"
  >
    <header class="history-panel__head">
      <h2 id="history-title" class="st-h2">History</h2>
      <button type="button" class="sh-btn sh-btn--ghost" aria-label="Close" @click="emit('close')">
        ×
      </button>
    </header>
    <p v-if="error" class="history-panel__error" role="alert">{{ error }}</p>
    <p v-if="loading" class="st-status" role="status">Loading…</p>
    <ul v-else class="history-panel__list" role="list">
      <li v-for="c in commits" :key="c.oid" class="history-panel__row">
        <div class="history-panel__meta">
          <span class="history-panel__when">{{ formatWhen(c.timeUnix) }}</span>
          <span class="history-panel__who">{{ c.committerName }}</span>
        </div>
        <p class="history-panel__msg">{{ c.message }}</p>
        <button type="button" class="sh-btn sh-btn--secondary sh-btn--sm" @click="askRestore(c)">
          Restore
        </button>
      </li>
    </ul>
    <div
      v-if="confirmEntry"
      class="history-panel__confirm st-dlg"
      role="alertdialog"
      aria-labelledby="history-restore-title"
      aria-describedby="history-restore-body"
      data-test="history-restore-confirm"
    >
      <h3 id="history-restore-title" class="st-h3">Restore this version?</h3>
      <p id="history-restore-body" class="st-body">
        Your book will match
        <strong>{{ formatWhen(confirmEntry.timeUnix) }}</strong>
        ({{ confirmEntry.message }}). This adds a new history entry; nothing is deleted.
      </p>
      <div class="history-panel__confirm-actions">
        <button type="button" class="sh-btn sh-btn--secondary" @click="cancelRestore">
          Cancel
        </button>
        <button type="button" class="sh-btn sh-btn--primary" @click="doRestore">Restore</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.history-panel {
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-3);
  padding: var(--ct-space-4);
  background: var(--ct-surface);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-md);
  max-height: min(70vh, 32rem);
  overflow: auto;
}
.history-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ct-space-2);
}
.history-panel__error {
  color: var(--ct-danger);
}
.history-panel__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-3);
}
.history-panel__row {
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-1);
  padding-bottom: var(--ct-space-3);
  border-bottom: 1px solid var(--ct-border);
}
.history-panel__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ct-space-2);
  font-size: var(--ct-text-sm);
  color: var(--ct-text-muted);
}
.history-panel__msg {
  margin: 0;
}
.history-panel__confirm {
  margin-top: var(--ct-space-3);
  padding: var(--ct-space-4);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-md);
  background: var(--ct-bg);
}
.history-panel__confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--ct-space-2);
  margin-top: var(--ct-space-3);
}
</style>
