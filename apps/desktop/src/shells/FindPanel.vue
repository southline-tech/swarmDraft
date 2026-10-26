<script setup lang="ts">
/**
 * Find & replace panel (wp3, #53). UI shell: matches are counted read-only from the document
 * text; Replace and Replace all are not wired yet and never change the manuscript.
 */
import { computed, nextTick, onMounted, ref, toRaw } from 'vue';
import type { Editor } from '@tiptap/core';

const props = defineProps<{ editor?: Editor }>();
const emit = defineEmits<{ close: [] }>();

const query = ref('');
const replacement = ref('');
const matchCase = ref(false);
const wholeWord = ref(false);
const current = ref(0);
const input = ref<HTMLInputElement>();

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Number of matches, counted per text block so a match never spans two paragraphs. */
const total = computed(() => {
  const e = props.editor && toRaw(props.editor);
  const q = query.value;
  if (!e || !q) return 0;
  const re = new RegExp(
    wholeWord.value ? `(?<![\\p{L}\\p{M}\\p{N}])${escape(q)}(?![\\p{L}\\p{M}\\p{N}])` : escape(q),
    matchCase.value ? 'gu' : 'giu',
  );
  let n = 0;
  e.state.doc.descendants((node) => {
    if (!node.isTextblock) return true;
    n += node.textContent.match(re)?.length ?? 0;
    return false;
  });
  return n;
});
const label = computed(() =>
  !query.value
    ? ''
    : total.value
      ? `${Math.min(current.value + 1, total.value)} of ${total.value}`
      : 'No matches',
);
function step(d: 1 | -1) {
  if (total.value) current.value = (current.value + d + total.value) % total.value;
}
const NOT_YET = 'Replace is not available yet';
onMounted(() => nextTick(() => input.value?.focus()));
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
        ref="input"
        v-model="query"
        class="sh-inp"
        data-test="find-input"
        aria-label="Find"
        placeholder="Find"
        @input="current = 0"
        @keydown.enter.prevent="step($event.shiftKey ? -1 : 1)"
      />
      <span class="sh-count" role="status" data-test="find-count">{{ label }}</span>
      <button type="button" class="sh-tbtn sh-icon" aria-label="Previous match" @click="step(-1)">
        ‹
      </button>
      <button type="button" class="sh-tbtn sh-icon" aria-label="Next match" @click="step(1)">
        ›
      </button>
      <button
        type="button"
        class="sh-tbtn sh-icon"
        aria-label="Close find"
        data-test="find-close"
        @click="emit('close')"
      >
        ×
      </button>
    </div>
    <div class="sh-row">
      <input
        v-model="replacement"
        class="sh-inp"
        data-test="replace-input"
        aria-label="Replace with"
        placeholder="Replace with…"
      />
      <button
        type="button"
        class="sh-tbtn"
        data-test="replace-one"
        aria-disabled="true"
        :title="NOT_YET"
      >
        Replace
      </button>
      <button
        type="button"
        class="sh-tbtn"
        data-test="replace-all"
        aria-disabled="true"
        :title="NOT_YET"
      >
        Replace all
      </button>
    </div>
    <div class="sh-row">
      <button
        type="button"
        class="sh-chip"
        :aria-pressed="matchCase"
        @click="
          matchCase = !matchCase;
          current = 0;
        "
      >
        Match case
      </button>
      <button
        type="button"
        class="sh-chip"
        :aria-pressed="wholeWord"
        @click="
          wholeWord = !wholeWord;
          current = 0;
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
