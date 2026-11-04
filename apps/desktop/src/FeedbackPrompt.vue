<script setup lang="ts">
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
const busyId = ref<string | null>(null);
const inlineError = ref('');
const dialog = ref<HTMLElement | null>(null);
let opener: HTMLElement | null = null;
let stopListen = () => {};

async function syncQueue() {
  try {
    queue.value = (await props.api.listPending()) ?? [];
  } catch (e) {
    console.error('List pending feedback failed', e);
  }
}

async function afterQueueChange() {
  inlineError.value = '';
  if (queue.value.length) {
    await nextTick();
    dialog.value?.querySelector<HTMLButtonElement>('[data-test="feedback-deny"]')?.focus();
    return;
  }
  if (opener?.isConnected) opener.focus();
  opener = null;
}

async function onDenied(id: string) {
  if (busyId.value) return;
  busyId.value = id;
  try {
    await props.api.deny(id);
    await syncQueue();
    await afterQueueChange();
  } catch (e) {
    inlineError.value = errorLine(e);
  } finally {
    busyId.value = null;
  }
}

async function onAllowed(id: string) {
  if (busyId.value) return;
  busyId.value = id;
  try {
    await props.api.approve(id);
    await syncQueue();
    await afterQueueChange();
  } catch (e) {
    inlineError.value = feedbackErrorMessage(typeof e === 'string' ? e : '') || errorLine(e);
  } finally {
    busyId.value = null;
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && queue.value.length === 1 && !busyId.value) {
    e.stopPropagation();
    void onDenied(queue.value[0]!.id);
  } else if (dialog.value) trapTab(e, dialog.value);
}

watch(
  () => queue.value.length,
  async (n, prev) => {
    if (n && !prev) {
      const active = document.activeElement;
      opener = active instanceof HTMLElement ? active : null;
    }
    if (!n) await afterQueueChange();
  },
);

onMounted(async () => {
  if (!isTauri()) return;
  await syncQueue();
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
    <div v-if="queue.length" class="st-dlg-scrim" data-test="feedback-bot-scrim">
      <div
        ref="dialog"
        class="st-dlg"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="fb-title"
        data-test="feedback-bot-dialog"
        @keydown="onKeydown"
      >
        <h2 id="fb-title" class="st-h2">
          Send feedback from <bdi dir="auto">{{ queue[0]!.agentName }}</bdi
          >?
        </h2>
        <ul class="fb-list">
          <li v-for="item in queue" :key="item.id" data-test="feedback-bot-row">
            <p class="st-muted">
              {{ FEEDBACK_TYPE_LABELS[item.type] }} · {{ FEEDBACK_AREA_LABELS[item.area] }}
            </p>
            <p>{{ item.description }}</p>
            <div class="st-dlg__actions">
              <button
                type="button"
                class="st-btn"
                data-test="feedback-deny"
                :disabled="!!busyId"
                @click="onDenied(item.id)"
              >
                Deny
              </button>
              <button
                type="button"
                class="st-btn st-btn--primary"
                data-test="feedback-allow"
                :disabled="!!busyId"
                @click="onAllowed(item.id)"
              >
                Allow
              </button>
            </div>
          </li>
        </ul>
        <p v-if="inlineError" role="alert" data-test="feedback-bot-error">{{ inlineError }}</p>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.fb-list {
  margin: var(--ct-space-3) 0 0;
  padding: 0;
  list-style: none;
}
</style>
