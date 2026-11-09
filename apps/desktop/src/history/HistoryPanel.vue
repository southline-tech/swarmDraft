<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { DraftCommitEntry } from '../backend';
import { draftHistory, draftRestore } from '../backend';
import AppIcon from '../icons/AppIcon.vue';
import { APP_OVERLAY_LAYER, ensureOverlayLayer } from '../overlay/layer';
import { trapTab } from '../settings/focus-trap';
import '../shells/shells.css';

const props = defineProps<{
  open: boolean;
  manuscriptId: string | null;
  /** File → History trigger; focus returns here on close. */
  menuTrigger?: HTMLElement | null;
  /** Flush pending edits into history before SQLite is hydrated from git. */
  beforeRestore?: () => void | Promise<void>;
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
const overlayReady = ref(false);
const panel = ref<HTMLElement | null>(null);
const closeBtn = ref<HTMLButtonElement | null>(null);
const restoreCancelBtn = ref<HTMLButtonElement | null>(null);

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
  async ([open]) => {
    if (open) {
      ensureOverlayLayer();
      overlayReady.value = true;
      confirmOid.value = null;
      await load();
      await nextTick();
      closeBtn.value?.focus();
    } else {
      confirmOid.value = null;
    }
  },
);

function formatWhen(unix: number) {
  return new Date(unix * 1000).toLocaleString();
}

function askRestore(entry: DraftCommitEntry) {
  confirmOid.value = entry.oid;
  void nextTick(() => restoreCancelBtn.value?.focus());
}

function cancelRestore() {
  confirmOid.value = null;
  void nextTick(() => closeBtn.value?.focus());
}

async function doRestore() {
  if (!props.manuscriptId || !confirmOid.value) return;
  try {
    await props.beforeRestore?.();
    await draftRestore(props.manuscriptId, confirmOid.value);
    confirmOid.value = null;
    emit('restored');
    await load();
  } catch (e) {
    console.error('Restore failed', e);
    error.value =
      "Couldn't restore that version. Your book wasn't changed and your edits are still here.";
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    if (confirmOid.value) cancelRestore();
    else emit('close');
  } else if (panel.value) {
    trapTab(e, panel.value);
  }
}

function onScrimClick() {
  if (confirmOid.value) cancelRestore();
  else emit('close');
}

onBeforeUnmount(() => {
  props.menuTrigger?.focus?.();
});

watch(
  () => props.open,
  (open, wasOpen) => {
    if (wasOpen && !open) props.menuTrigger?.focus?.();
  },
);
</script>

<template>
  <Teleport v-if="open && overlayReady" :to="APP_OVERLAY_LAYER">
    <div
      class="st-dlg-scrim history-scrim"
      data-test="history-scrim"
      @mousedown.self="onScrimClick"
    >
      <div
        ref="panel"
        class="st-dlg history-panel"
        role="dialog"
        aria-labelledby="history-title"
        aria-modal="true"
        data-test="history-panel"
        @keydown="onKeydown"
      >
        <header class="history-panel__head">
          <h2 id="history-title" class="st-h2">History</h2>
          <button
            ref="closeBtn"
            type="button"
            class="sh-tbtn sh-icon"
            aria-label="Close history"
            data-test="history-close"
            @click="emit('close')"
          >
            <AppIcon name="x" />
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
            <button
              type="button"
              class="sh-btn sh-btn--secondary sh-btn--sm"
              @click="askRestore(c)"
            >
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
            ({{ confirmEntry.message }}). Unsaved edits are saved as a new history entry first, then
            this version is restored. Nothing is deleted.
          </p>
          <div class="history-panel__confirm-actions">
            <button
              ref="restoreCancelBtn"
              type="button"
              class="sh-btn sh-btn--secondary"
              @click="cancelRestore"
            >
              Cancel
            </button>
            <button type="button" class="sh-btn sh-btn--primary" @click="doRestore">Restore</button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
