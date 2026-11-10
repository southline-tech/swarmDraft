<script setup lang="ts">
/**
 * Read-only view of a change that has already been accepted, rejected, or edited later (#123).
 * Layout lives in shells.css next to `.st-dlg` (the node is teleported).
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { markAuthorLabel, UNNAMED_AGENT } from '../agent-names';
import AppIcon from '../icons/AppIcon.vue';
import { ensureOverlayLayer, APP_OVERLAY_LAYER } from '../overlay/layer';
import { trapTab } from '../settings/focus-trap';
import '../shells/shells.css';
import type { OldChangeViewModel } from './open-link';

const props = defineProps<{
  view: OldChangeViewModel;
  /** 1-based chapter index when the change's section is still a chapter. */
  chapterNumber?: number | null;
  /** Focus the editor when the opener is the document body, or Back to my book is used. */
  focusEditor?: () => void;
}>();
const emit = defineEmits<{ close: []; 'go-chapter': [] }>();

const panel = ref<HTMLElement | null>(null);
const backBtn = ref<HTMLButtonElement | null>(null);
const overlayReady = ref(false);
let opener: HTMLElement | null = null;
/** `editor` always returns to the manuscript. `none` leaves focus to Go to Chapter. */
let focusPlan: 'opener' | 'editor' | 'none' = 'opener';

const settled = computed(
  () => props.view.outcome === 'accepted' || props.view.outcome === 'rejected',
);
const decider = computed(() => props.view.decidedBy.trim());
const rawAuthor = computed(() => props.view.authorName.trim());
const authorIsBot = computed(
  () => props.view.authorKind === 'agent' || rawAuthor.value.startsWith('agent:'),
);
/** Saved display name. A raw `agent:<id>` mark is never shown. */
const author = computed(() => {
  const raw = rawAuthor.value;
  if (raw.startsWith('agent:')) return markAuthorLabel(raw).name;
  if (authorIsBot.value && !raw) return UNNAMED_AGENT;
  return raw;
});
const verb = computed(() => (props.view.outcome === 'rejected' ? 'rejected' : 'accepted'));

function heading(outcome: string): string {
  if (outcome === 'accepted') return 'This change was accepted';
  if (outcome === 'rejected') return 'This change was rejected';
  return 'This change was edited later';
}

function kindLabel(kind: string): string {
  if (kind === 'suggestion_insert') return 'Added text';
  if (kind === 'suggestion_delete') return 'Removed text';
  if (kind === 'format_change') return 'Formatting';
  return 'Change';
}

function whenLabel(unix: number | null): string {
  if (unix == null) return '';
  return new Date(unix * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const whenText = computed(() => whenLabel(props.view.decidedAt));
const settledMiddle = computed(() =>
  decider.value ? ` ${verb.value} ` : verb.value === 'rejected' ? 'Rejected ' : 'Accepted ',
);
const authorSuffix = computed(() => (author.value ? "'s change" : 'this change'));
const whenSuffix = computed(() => (whenText.value ? ` · ${whenText.value}` : ''));
const editedRest = computed(() =>
  author.value
    ? " suggested this change. It was changed again later, so it's no longer in your book."
    : "This change was suggested. It was changed again later, so it's no longer in your book.",
);
const quoteClass = computed(() => {
  if (props.view.kind === 'suggestion_insert') return 'old-change__quote--insert';
  if (props.view.kind === 'suggestion_delete') return 'old-change__quote--delete';
  if (props.view.kind === 'format_change') return 'old-change__quote--format';
  return undefined;
});

function usefulOpener(el: HTMLElement | null): el is HTMLElement {
  return !!el && el !== document.body && el.isConnected;
}

function close() {
  focusPlan = 'opener';
  emit('close');
}

function backToBook() {
  focusPlan = 'editor';
  emit('close');
}

function goChapter() {
  focusPlan = 'none';
  emit('go-chapter');
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
  void nextTick(() => backBtn.value?.focus());
});

onBeforeUnmount(() => {
  if (focusPlan === 'none') return;
  if (focusPlan === 'editor' || !usefulOpener(opener)) {
    props.focusEditor?.();
    return;
  }
  opener.focus();
});
</script>

<template>
  <Teleport v-if="overlayReady" :to="APP_OVERLAY_LAYER">
    <div
      class="st-dlg-scrim"
      data-test="old-change-scrim"
      @mousedown.self="close"
      @keydown="onKeydown"
    >
      <div
        ref="panel"
        class="st-dlg old-change"
        role="dialog"
        aria-modal="true"
        aria-labelledby="old-change-title"
        aria-describedby="old-change-summary"
        data-test="old-change-view"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <header class="old-change__head">
          <h2 id="old-change-title" data-test="old-change-outcome">{{ heading(view.outcome) }}</h2>
          <button
            type="button"
            class="sh-tbtn sh-icon"
            data-test="old-change-close"
            aria-label="Close"
            @click="close"
          >
            <AppIcon name="x" />
          </button>
        </header>
        <!-- prettier-ignore -->
        <p id="old-change-summary" class="old-change__summary" data-test="old-change-summary">
          <template v-if="settled"><bdi v-if="decider" dir="auto">{{ decider }}</bdi>{{ settledMiddle }}<bdi v-if="author" dir="auto" data-test="old-change-author">{{ author }}</bdi><template v-if="authorIsBot"> <span class="agent-tag" data-test="agent-tag">Bot</span></template>{{ authorSuffix }}<span v-if="whenText" data-test="old-change-when">{{ whenSuffix }}</span></template>
          <template v-else><bdi v-if="author" dir="auto" data-test="old-change-author">{{ author }}</bdi><template v-if="authorIsBot"> <span class="agent-tag" data-test="agent-tag">Bot</span></template>{{ editedRest }}</template>
        </p>
        <p class="old-change__kind" data-test="old-change-kind">{{ kindLabel(view.kind) }}</p>
        <p class="old-change__label" data-test="old-change-quote-label">Original wording</p>
        <blockquote
          v-if="view.quote"
          class="old-change__quote"
          :class="quoteClass"
          data-suggester=""
          data-test="old-change-quote"
        >
          {{ view.quote }}
        </blockquote>
        <p v-else class="old-change__missing" data-test="old-change-quote">
          The original wording wasn't saved with this change.
        </p>
        <div class="old-change__actions">
          <button
            v-if="chapterNumber"
            type="button"
            class="sh-btn"
            data-test="old-change-chapter"
            @click="goChapter"
          >
            Go to Chapter {{ chapterNumber }}
          </button>
          <button
            ref="backBtn"
            type="button"
            class="sh-btn sh-btn--primary"
            data-test="old-change-back"
            @click="backToBook"
          >
            Back to my book
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
