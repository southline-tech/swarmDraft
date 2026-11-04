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
  validateFeedbackForm,
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
const sent = ref(false);
const sendError = ref('');
const fieldError = ref('');

const area = ref<FeedbackArea>('editor');
const feedbackType = ref<FeedbackType>('bug');
const description = ref('');
const replyEmail = ref('');
const includeText = ref(false);
const includeDiagnostics = ref(false);

const canSend = computed(
  () => !sending.value && description.value.trim().length > 0 && !sent.value,
);

const emailErrorId = 'feedback-email-error';
const descriptionErrorId = 'feedback-description-error';

function onTypeKeydown(e: KeyboardEvent, t: FeedbackType) {
  const idx = FEEDBACK_TYPES.indexOf(t);
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    e.preventDefault();
    feedbackType.value = FEEDBACK_TYPES[(idx + 1) % FEEDBACK_TYPES.length]!;
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    e.preventDefault();
    feedbackType.value = FEEDBACK_TYPES[(idx + FEEDBACK_TYPES.length - 1) % FEEDBACK_TYPES.length]!;
  }
}

function validateFields(): boolean {
  const msg = validateFeedbackForm(description.value, replyEmail.value);
  fieldError.value = msg ?? '';
  return !msg;
}

let successTimer: ReturnType<typeof setTimeout> | undefined;

async function submit() {
  if (sending.value || sent.value) return;
  if (!validateFields()) return;
  sending.value = true;
  sendError.value = '';
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
      includeDiagnostics: includeDiagnostics.value,
    });
    sent.value = true;
    successTimer = setTimeout(() => emit('close'), 1500);
  } catch (e) {
    sendError.value = feedbackErrorMessage(typeof e === 'string' ? e : String(e));
  } finally {
    sending.value = false;
  }
}

function retrySend() {
  sendError.value = '';
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && !sending.value) {
    e.stopPropagation();
    emit('close');
  } else if (dialog.value) trapTab(e, dialog.value);
}

onMounted(async () => {
  ensureOverlayLayer();
  overlayReady.value = true;
  await nextTick();
  descriptionInput.value?.focus();
});

onBeforeUnmount(() => {
  if (successTimer) clearTimeout(successTimer);
});
</script>

<template>
  <Teleport v-if="overlayReady" :to="APP_OVERLAY_LAYER">
    <div class="st-dlg-scrim" data-test="feedback-overlay" @mousedown.self.prevent="emit('close')">
      <div
        ref="dialog"
        class="st-dlg st-dlg--feedback"
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
              :tabindex="feedbackType === t ? 0 : -1"
              :data-test="`feedback-type-${t}`"
              @click="feedbackType = t"
              @keydown="onTypeKeydown($event, t)"
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
            rows="6"
            maxlength="4000"
            required
            aria-required="true"
            :aria-invalid="fieldError === 'Add a message.' ? 'true' : undefined"
            :aria-describedby="fieldError === 'Add a message.' ? descriptionErrorId : undefined"
            data-test="feedback-description"
            @blur="validateFields()"
          />
        </label>
        <p
          v-if="fieldError === 'Add a message.'"
          :id="descriptionErrorId"
          class="st-field-error"
          role="alert"
        >
          {{ fieldError }}
        </p>
        <label class="st-row st-row--stack" for="feedback-email">
          <span class="st-row__k">Reply email <span class="st-muted">(optional)</span></span>
          <input
            id="feedback-email"
            v-model="replyEmail"
            type="email"
            class="st-inp"
            :aria-invalid="fieldError && fieldError !== 'Add a message.' ? 'true' : undefined"
            :aria-describedby="
              fieldError && fieldError !== 'Add a message.' ? emailErrorId : undefined
            "
            @blur="validateFields()"
          />
        </label>
        <p
          v-if="fieldError && fieldError !== 'Add a message.'"
          :id="emailErrorId"
          class="st-field-error"
          role="alert"
        >
          {{ fieldError }}
        </p>
        <label v-if="excerpt?.trim()" class="st-row st-row--check">
          <input v-model="includeText" type="checkbox" data-test="feedback-include-text" />
          <span>Include a short excerpt from my book (opt-in)</span>
        </label>
        <label class="st-row st-row--check">
          <input
            v-model="includeDiagnostics"
            type="checkbox"
            data-test="feedback-include-diagnostics"
          />
          <span>Include diagnostics (version, OS, recent errors)</span>
        </label>
        <p v-if="sent" class="st-status" role="status" data-test="feedback-status">
          Thanks — your feedback was sent.
        </p>
        <div v-if="sendError" class="st-field-error st-field-error--block" role="alert">
          <p data-test="feedback-send-error">{{ sendError }}</p>
          <button
            type="button"
            class="st-btn st-btn--link"
            data-test="feedback-try-again"
            @click="retrySend"
          >
            Try again
          </button>
        </div>
        <div class="st-dlg__actions">
          <button type="button" class="st-btn" data-test="feedback-cancel" @click="emit('close')">
            Cancel
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
