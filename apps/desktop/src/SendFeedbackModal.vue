<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { AppInfo } from './backend';
import {
  feedbackApi,
  feedbackErrorMessage,
  FEEDBACK_AREAS,
  FEEDBACK_AREA_LABELS,
  FEEDBACK_TYPES,
  FEEDBACK_TYPE_LABELS,
  type FeedbackArea,
  type FeedbackType,
} from './feedback-client';
import { APP_OVERLAY_LAYER, ensureOverlayLayer } from './overlay/layer';
import { trapTab } from './settings/focus-trap';
import './settings/settings.css';

const props = defineProps<{ info: AppInfo | null; excerpt?: string | null }>();
const emit = defineEmits<{ close: [] }>();

const dialog = ref<HTMLElement | null>(null);
const descriptionInput = ref<HTMLTextAreaElement | null>(null);
const overlayReady = ref(false);
const sending = ref(false);
const status = ref('');
const sent = ref(false);

const area = ref<FeedbackArea>('editor');
const feedbackType = ref<FeedbackType>('bug');
const description = ref('');
const replyEmail = ref('');
const includeText = ref(false);

const canSend = computed(
  () => !sending.value && description.value.trim().length > 0 && !sent.value,
);

async function submit() {
  if (!canSend.value) return;
  sending.value = true;
  status.value = '';
  try {
    await feedbackApi.send({
      area: area.value,
      type: feedbackType.value,
      description: description.value,
      replyEmail: replyEmail.value.trim() || undefined,
      includeText: includeText.value,
      excerpt:
        includeText.value && props.excerpt?.trim()
          ? props.excerpt.trim().slice(0, 2000)
          : undefined,
    });
    sent.value = true;
    status.value = 'Thanks — your feedback was sent.';
  } catch (e) {
    status.value = feedbackErrorMessage(typeof e === 'string' ? e : String(e));
  } finally {
    sending.value = false;
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && !sending.value) {
    e.stopPropagation();
    emit('close');
  } else if (dialog.value) trapTab(e, dialog.value);
}

let opener: HTMLElement | null = null;

onMounted(async () => {
  ensureOverlayLayer();
  overlayReady.value = true;
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  await nextTick();
  descriptionInput.value?.focus();
});

onBeforeUnmount(() => {
  if (opener?.isConnected) opener.focus();
});
</script>

<template>
  <Teleport v-if="overlayReady" :to="APP_OVERLAY_LAYER">
    <div class="st-dlg-scrim" data-test="feedback-overlay" @mousedown.self.prevent="emit('close')">
      <div
        ref="dialog"
        class="st-dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-title"
        tabindex="-1"
        data-test="feedback-dialog"
        @keydown="onKeydown"
      >
        <h2 id="feedback-title" class="st-h2">Send feedback</h2>
        <p class="st-muted st-desc st-flush">
          Tell us what happened or what you'd like. We use this to improve swarmDraft.
          <span v-if="info"> Version {{ info.version }} is included automatically.</span>
        </p>
        <label class="st-row st-row--stack" for="feedback-area">
          <span class="st-row__k">Area</span>
          <select id="feedback-area" v-model="area" class="st-inp" data-test="feedback-area">
            <option v-for="a in FEEDBACK_AREAS" :key="a" :value="a">
              {{ FEEDBACK_AREA_LABELS[a] }}
            </option>
          </select>
        </label>
        <fieldset class="st-fieldset">
          <legend class="st-row__k">Type</legend>
          <div class="st__seg" role="radiogroup" aria-label="Feedback type">
            <button
              v-for="t in FEEDBACK_TYPES"
              :key="t"
              type="button"
              role="radio"
              class="st__segb"
              :class="{ 'st__segb--on': feedbackType === t }"
              :aria-checked="feedbackType === t"
              :data-test="`feedback-type-${t}`"
              @click="feedbackType = t"
            >
              {{ FEEDBACK_TYPE_LABELS[t] }}
            </button>
          </div>
        </fieldset>
        <label class="st-row st-row--stack" for="feedback-description">
          <span class="st-row__k">Description</span>
          <textarea
            id="feedback-description"
            ref="descriptionInput"
            v-model="description"
            class="st-inp st-inp--area"
            rows="5"
            maxlength="4000"
            data-test="feedback-description"
          />
        </label>
        <label class="st-row st-row--stack" for="feedback-email">
          <span class="st-row__k">Reply email <span class="st-muted">(optional)</span></span>
          <input id="feedback-email" v-model="replyEmail" type="email" class="st-inp" />
        </label>
        <label v-if="excerpt?.trim()" class="st-row st-row--check">
          <input v-model="includeText" type="checkbox" data-test="feedback-include-text" />
          <span>Include a short excerpt from my book (opt-in)</span>
        </label>
        <p v-if="status" class="st-status" role="status" data-test="feedback-status">
          {{ status }}
        </p>
        <div class="st-dlg__actions">
          <button type="button" class="st-btn" data-test="feedback-cancel" @click="emit('close')">
            {{ sent ? 'Close' : 'Cancel' }}
          </button>
          <button
            type="button"
            class="st-btn st-btn--primary"
            data-test="feedback-send"
            :disabled="!canSend"
            @click="submit"
          >
            {{ sending ? 'Sending…' : sent ? 'Sent' : 'Send' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
