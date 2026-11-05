<script setup lang="ts">
/**
 * Bot feedback approval (#208, #269/#270 queue pattern).
 */
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  feedbackApi,
  feedbackErrorMessage,
  FEEDBACK_AREA_LABELS,
  FEEDBACK_TYPE_LABELS,
  type FeedbackApi,
  type FeedbackPendingSummary,
} from './feedback-client';
import { errorLine } from './errors/map-error';
import { trapTab } from './settings/focus-trap';
import { APP_OVERLAY_LAYER } from './overlay/layer';
import './settings/settings.css';

const props = withDefaults(defineProps<{ api?: FeedbackApi }>(), { api: () => feedbackApi });

const queue = ref<FeedbackPendingSummary[]>([]);
const deferred = ref(false);
const busyId = ref<string | null>(null);
const bulkBusy = ref(false);
const inlineError = ref('');
const includeExcerptById = ref<Record<string, boolean>>({});
const dialog = ref<HTMLElement | null>(null);
const denyAllButton = ref<HTMLButtonElement | null>(null);
let opener: HTMLElement | null = null;
let stopListen = () => {};

function excerptChecked(id: string): boolean {
  return includeExcerptById.value[id] ?? false;
}

function setExcerptChecked(id: string, on: boolean) {
  includeExcerptById.value = { ...includeExcerptById.value, [id]: on };
}

async function syncQueue() {
  try {
    queue.value = (await props.api.listPending()) ?? [];
    if (queue.value.length) deferred.value = false;
  } catch (e) {
    console.error('List pending feedback failed', e);
  }
}

async function afterQueueChange() {
  inlineError.value = '';
  if (queue.value.length && !deferred.value) {
    await nextTick();
    const focusEl =
      queue.value.length === 1
        ? dialog.value?.querySelector<HTMLButtonElement>('[data-test="feedback-deny"]')
        : denyAllButton.value;
    focusEl?.focus();
    return;
  }
  if (!queue.value.length && opener?.isConnected) {
    await nextTick();
    opener.focus();
  }
  if (!queue.value.length) opener = null;
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
    inlineError.value = feedbackErrorMessage(typeof e === 'string' ? e : '') || errorLine(e);
  } finally {
    busyId.value = null;
  }
}

async function onAllowed(id: string) {
  if (busyId.value || bulkBusy.value) return;
  busyId.value = id;
  inlineError.value = '';
  try {
    await props.api.approve(id, { includeExcerpt: excerptChecked(id) });
    await syncQueue();
    await afterQueueChange();
  } catch (e) {
    inlineError.value = feedbackErrorMessage(typeof e === 'string' ? e : '') || errorLine(e);
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
    inlineError.value = errorLine(e);
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
      await props.api.approve(row.id, { includeExcerpt: excerptChecked(row.id) });
    }
    await syncQueue();
    await afterQueueChange();
  } catch (e) {
    inlineError.value = feedbackErrorMessage(typeof e === 'string' ? e : '') || errorLine(e);
    await syncQueue();
  } finally {
    bulkBusy.value = false;
  }
}

function deferDialog() {
  if (busyId.value || bulkBusy.value) return;
  deferred.value = true;
  inlineError.value = '';
  if (opener?.isConnected) opener.focus();
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    deferDialog();
  } else if (dialog.value) trapTab(e, dialog.value);
}

watch(
  () => queue.value.length,
  async (n, prev) => {
    if (n > 0 && prev === 0) {
      const active = document.activeElement;
      opener = active instanceof HTMLElement ? active : null;
      await afterQueueChange();
    }
    if (!n) await afterQueueChange();
  },
);

onMounted(async () => {
  await syncQueue();
  if (queue.value.length) {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    await afterQueueChange();
  }
  if (!isTauri()) return;
  const unlisten = await listen('feedback-requested', () => {
    void syncQueue();
  });
  stopListen = () => {
    void unlisten();
  };
});

onBeforeUnmount(() => {
  stopListen();
});
</script>

<template>
  <Teleport :to="APP_OVERLAY_LAYER">
    <div v-if="queue.length && !deferred" class="st-dlg-scrim" data-test="feedback-bot-scrim">
      <div
        ref="dialog"
        class="st-dlg fb-batch"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="fb-title"
        aria-describedby="fb-hint"
        data-test="feedback-bot-dialog"
        @keydown="onKeydown"
      >
        <h2 id="fb-title" class="st-h2 fb-batch__title">
          {{
            queue.length === 1
              ? 'Send feedback from a bot?'
              : `Send feedback from ${queue.length} bots?`
          }}
        </h2>
        <p id="fb-hint" class="st-muted st-desc st-flush">
          Esc closes for now; pending requests stay until you Allow or Deny.
        </p>
        <ul class="fb-batch__list">
          <li
            v-for="item in queue"
            :key="item.id"
            class="fb-batch__row"
            data-test="feedback-bot-row"
          >
            <div class="fb-batch__head">
              <bdi class="fb-batch__name" dir="auto">{{ item.agentName }}</bdi>
              <span class="st-tag">Bot</span>
            </div>
            <p class="st-muted fb-batch__meta">
              {{ FEEDBACK_TYPE_LABELS[item.type] }} · {{ FEEDBACK_AREA_LABELS[item.area] }}
            </p>
            <p class="fb-batch__desc">{{ item.description }}</p>
            <p
              v-if="item.excerpt?.trim()"
              class="fb-batch__excerpt"
              data-test="feedback-bot-excerpt"
            >
              {{ item.excerpt.trim() }}
            </p>
            <label
              v-if="item.excerpt?.trim()"
              class="st-row st-row--check fb-batch__check"
              :for="`fb-excerpt-${item.id}`"
            >
              <input
                :id="`fb-excerpt-${item.id}`"
                type="checkbox"
                :checked="excerptChecked(item.id)"
                data-test="feedback-bot-include-excerpt"
                @change="setExcerptChecked(item.id, ($event.target as HTMLInputElement).checked)"
              />
              <span>Include excerpt in feedback (opt-in)</span>
            </label>
            <div class="fb-batch__row-actions">
              <button
                type="button"
                class="st-btn st-btn--s"
                :data-test="queue.length === 1 ? 'feedback-deny' : `feedback-deny-${item.id}`"
                :disabled="!!busyId || bulkBusy"
                @click="onDenied(item.id)"
              >
                Deny
              </button>
              <button
                type="button"
                class="st-btn st-btn--primary st-btn--s"
                :data-test="queue.length === 1 ? 'feedback-allow' : `feedback-allow-${item.id}`"
                :disabled="!!busyId || bulkBusy"
                @click="onAllowed(item.id)"
              >
                Allow
              </button>
            </div>
          </li>
        </ul>
        <p v-if="inlineError" class="fb-batch__error" role="alert" data-test="feedback-bot-error">
          {{ inlineError }}
        </p>
        <div v-if="queue.length > 1" class="fb-batch__actions">
          <button
            ref="denyAllButton"
            type="button"
            class="st-btn"
            data-test="feedback-deny-all"
            :disabled="!!busyId || bulkBusy"
            @click="denyAll()"
          >
            Deny all
          </button>
          <button
            type="button"
            class="st-btn st-btn--primary"
            data-test="feedback-allow-all"
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
.fb-batch {
  max-width: 35rem;
}
.fb-batch__title {
  margin: 0 0 var(--ct-space-2);
}
.fb-batch__list {
  margin: var(--ct-space-3) 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-2);
}
.fb-batch__row {
  padding: var(--ct-space-2) var(--ct-space-3);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-md);
  background: var(--ct-bg);
}
.fb-batch__head {
  display: flex;
  align-items: center;
  gap: var(--ct-space-2);
  margin-bottom: var(--ct-space-1);
}
.fb-batch__name {
  font-weight: var(--ct-weight-semibold);
  font-size: var(--ct-text-sm);
}
.fb-batch__meta {
  margin: 0 0 var(--ct-space-1);
  font-size: var(--ct-text-sm);
}
.fb-batch__desc {
  margin: 0;
  white-space: pre-wrap;
}
.fb-batch__excerpt {
  margin: var(--ct-space-2) 0 0;
  padding: var(--ct-space-2);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-md);
  background: var(--ct-surface);
  font-size: var(--ct-text-sm);
  white-space: pre-wrap;
}
.fb-batch__check {
  margin-top: var(--ct-space-2);
}
.fb-batch__row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ct-space-2);
  justify-content: flex-end;
  margin-top: var(--ct-space-2);
}
.fb-batch__error {
  margin: var(--ct-space-3) 0 0;
  color: var(--ct-danger);
  font-size: var(--ct-text-sm);
}
.fb-batch__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--ct-space-3);
  margin-top: var(--ct-space-4);
}
</style>
