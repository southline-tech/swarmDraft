<script setup lang="ts">
/**
 * Read-only view of a change that has already been accepted or rejected (#123).
 * Reuses the shell scrim and dialog card. No new stacking.
 */
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import AppIcon from '../icons/AppIcon.vue';
import { ensureOverlayLayer, APP_OVERLAY_LAYER } from '../overlay/layer';
import { trapTab } from '../settings/focus-trap';
import '../shells/shells.css';
import type { OldChangeViewModel } from './open-link';

const props = defineProps<{ view: OldChangeViewModel }>();
const emit = defineEmits<{ close: [] }>();

const panel = ref<HTMLElement | null>(null);
const closeBtn = ref<HTMLButtonElement | null>(null);
const overlayReady = ref(false);
let opener: HTMLElement | null = null;

function heading(outcome: string): string {
  if (outcome === 'accepted') return 'Accepted';
  if (outcome === 'rejected') return 'Rejected';
  return 'Recorded';
}

function kindLabel(kind: string): string {
  if (kind === 'suggestion_delete') return 'Delete';
  if (kind === 'format_change') return 'Format';
  if (kind === 'suggestion_insert') return 'Insert';
  return kind;
}

function whenLabel(unix: number | null): string {
  if (unix == null) return '';
  const d = new Date(unix * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm} UTC`;
}

const who = () => props.view.decidedBy.trim() || props.view.authorName.trim();

function close() {
  emit('close');
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    close();
    return;
  }
  if (panel.value) trapTab(e, panel.value);
}

onMounted(() => {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  ensureOverlayLayer();
  overlayReady.value = true;
  void nextTick(() => closeBtn.value?.focus());
});

onBeforeUnmount(() => {
  opener?.focus();
});
</script>

<template>
  <Teleport v-if="overlayReady" :to="APP_OVERLAY_LAYER">
    <div
      class="sh-scrim scrim"
      data-test="old-change-scrim"
      @mousedown.self="close"
      @keydown="onKeydown"
    >
      <div
        ref="panel"
        class="st-dlg card dlg old-change"
        role="dialog"
        aria-modal="true"
        aria-labelledby="old-change-title"
        data-test="old-change-view"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <header class="old-change__head">
          <h2 id="old-change-title" data-test="old-change-outcome">{{ heading(view.outcome) }}</h2>
          <button
            ref="closeBtn"
            type="button"
            class="sh-tbtn sh-icon"
            data-test="old-change-close"
            aria-label="Close"
            @click="close"
          >
            <AppIcon name="x" />
          </button>
        </header>
        <p v-if="who()" class="old-change__who" data-test="old-change-who">
          By <bdi dir="auto">{{ who() }}</bdi>
        </p>
        <p v-if="whenLabel(view.decidedAt)" class="old-change__when" data-test="old-change-when">
          {{ whenLabel(view.decidedAt) }}
        </p>
        <p v-if="kindLabel(view.kind)" class="old-change__kind" data-test="old-change-kind">
          {{ kindLabel(view.kind) }}
        </p>
        <blockquote v-if="view.quote" class="old-change__quote" data-test="old-change-quote">
          {{ view.quote }}
        </blockquote>
        <p v-else class="old-change__quote" data-test="old-change-quote">
          The original wording is not stored with this decision.
        </p>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.old-change {
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-2);
  width: min(32rem, 100%);
  max-height: min(70vh, 32rem);
  overflow: auto;
  color: var(--ct-text);
  font-family: var(--ct-font-ui);
}
.old-change__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ct-space-2);
}
.old-change h2 {
  margin: 0;
  font-size: var(--ct-text-lg);
  font-weight: var(--ct-weight-semibold);
}
.old-change__who,
.old-change__when,
.old-change__kind {
  margin: 0;
  color: var(--ct-text-muted);
  font-size: var(--ct-text-sm);
}
.old-change__quote {
  margin: var(--ct-space-2) 0 0;
  padding: var(--ct-space-3);
  border: 0;
  border-left: 3px solid var(--ct-border-strong);
  background: var(--ct-surface);
  color: var(--ct-text);
  font-family: var(--ct-font-manuscript);
  white-space: pre-wrap;
}
</style>
