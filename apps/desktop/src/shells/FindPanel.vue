<script setup lang="ts">
/**
 * Find & replace panel (wp3, #53). Search highlights are decoration-only; replace runs through
 * `@coauthor/editor` find-replace helpers (one undo step per replace operation).
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue';
import type { Editor } from '@tiptap/core';
import {
  listFindMatches,
  replaceFindMatches,
  scrollFindMatchIntoView,
  updateFindHighlight,
  type FindMatch,
} from '@coauthor/editor';
import AppIcon from '../icons/AppIcon.vue';

const props = defineProps<{ editor?: Editor; focusReplace?: boolean }>();
const emit = defineEmits<{ close: [] }>();

const query = ref('');
const replacement = ref('');
const matchCase = ref(false);
const wholeWord = ref(false);
const current = ref(0);
const findInput = ref<HTMLInputElement>();
const replaceInput = ref<HTMLInputElement>();

const opts = computed(() => ({ matchCase: matchCase.value, wholeWord: wholeWord.value }));

const matches = computed((): FindMatch[] => {
  const e = props.editor && toRaw(props.editor);
  if (!e || !query.value) return [];
  return listFindMatches(e.state.doc, query.value, opts.value);
});

const total = computed(() => matches.value.length);

const label = computed(() =>
  !query.value
    ? ''
    : total.value
      ? `${Math.min(current.value + 1, total.value)} of ${total.value}`
      : 'No matches',
);

function syncHighlight() {
  const e = props.editor && toRaw(props.editor);
  if (!e) return;
  updateFindHighlight(e, matches.value, total.value ? current.value : 0);
}

/** Updates the active match highlight and scrolls it into view without moving editor focus or selection. */
function focusMatch(index: number) {
  const e = props.editor && toRaw(props.editor);
  const list = matches.value;
  if (!e || !list.length) return;
  const i = ((index % list.length) + list.length) % list.length;
  current.value = i;
  syncHighlight();
  scrollFindMatchIntoView(e, list[i]!);
}

function step(d: 1 | -1) {
  if (!total.value) return;
  focusMatch(current.value + d);
}

function onQueryChange() {
  current.value = 0;
  syncHighlight();
  if (total.value) focusMatch(0);
}

function replace(mode: 'one' | 'all') {
  const e = props.editor && toRaw(props.editor);
  if (!e || !query.value || !total.value) return;
  current.value = replaceFindMatches(
    e,
    query.value,
    replacement.value,
    opts.value,
    mode,
    current.value,
  );
  syncHighlight();
  if (listFindMatches(e.state.doc, query.value, opts.value).length) focusMatch(current.value);
}

watch(matches, () => {
  if (current.value >= total.value) current.value = Math.max(0, total.value - 1);
  syncHighlight();
});

watch(
  () => props.editor,
  (ed, _prev, onCleanup) => {
    if (!ed) return;
    const refresh = () => syncHighlight();
    ed.on('update', refresh);
    onCleanup(() => ed.off('update', refresh));
  },
  { immediate: true },
);

onMounted(() =>
  nextTick(() => {
    if (props.focusReplace) replaceInput.value?.focus();
    else findInput.value?.focus();
    syncHighlight();
  }),
);
onBeforeUnmount(() => {
  const e = props.editor && toRaw(props.editor);
  if (e) updateFindHighlight(e, [], 0);
});
</script>

<template>
  <div
    class="sh-find"
    role="search"
    aria-label="Find and replace"
    data-test="find-panel"
    @keydown.esc.stop="emit('close')"
  >
    <div class="sh-row">
      <input
        ref="findInput"
        v-model="query"
        class="sh-inp"
        data-test="find-input"
        aria-label="Find"
        placeholder="Find"
        @input="onQueryChange"
        @keydown.enter.prevent="step($event.shiftKey ? -1 : 1)"
        @keydown.esc.stop="emit('close')"
      />
      <span class="sh-count" role="status" data-test="find-count">{{ label }}</span>
      <button
        type="button"
        class="sh-tbtn sh-icon"
        aria-label="Previous match"
        data-test="find-prev"
        :disabled="!total"
        @click="step(-1)"
      >
        <AppIcon name="chevron-up" />
      </button>
      <button
        type="button"
        class="sh-tbtn sh-icon"
        aria-label="Next match"
        data-test="find-next"
        :disabled="!total"
        @click="step(1)"
      >
        <AppIcon name="chevron-down" />
      </button>
      <button
        type="button"
        class="sh-tbtn sh-icon"
        aria-label="Close find"
        data-test="find-close"
        @click="emit('close')"
      >
        <AppIcon name="x" />
      </button>
    </div>
    <div class="sh-row">
      <input
        ref="replaceInput"
        v-model="replacement"
        class="sh-inp"
        data-test="replace-input"
        aria-label="Replace with"
        placeholder="Replace with…"
        @keydown.esc.stop="emit('close')"
      />
      <button
        type="button"
        class="sh-tbtn"
        data-test="replace-one"
        :disabled="!total"
        @click="replace('one')"
      >
        Replace
      </button>
      <button
        type="button"
        class="sh-tbtn"
        data-test="replace-all"
        :disabled="!total"
        @click="replace('all')"
      >
        Replace all
      </button>
    </div>
    <div class="sh-row">
      <button
        type="button"
        class="sh-chip"
        data-test="find-match-case"
        :aria-pressed="matchCase"
        @click="
          matchCase = !matchCase;
          onQueryChange();
        "
      >
        Match case
      </button>
      <button
        type="button"
        class="sh-chip"
        data-test="find-whole-word"
        :aria-pressed="wholeWord"
        @click="
          wholeWord = !wholeWord;
          onQueryChange();
        "
      >
        Whole word
      </button>
      <button type="button" class="sh-chip" aria-disabled="true" title="Search scope: coming soon">
        This chapter ▾
      </button>
      <span class="sh-note">Suggestions are never replaced</span>
    </div>
  </div>
</template>
