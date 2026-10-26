<script setup lang="ts">
/**
 * Review panel (RAD-211, RAD-258, board WP 8): "Show changes from" filter, Previous/Next
 * step-through, Accept/Reject on the current change, and Accept all / Reject all for the visible
 * changes behind a confirmation. Human-only: accept/reject is a desktop command, never an agent
 * tool. Presentational: the host owns the filter and current change and applies decisions.
 * Authors are raw ids; `labels` only changes what is shown.
 */
import { computed, ref } from 'vue';
import { authorColor, type Decision, type SuggestionItem } from '@coauthor/editor';
import {
  authorsOf,
  filterSummary,
  keyOf,
  REVIEW_SHORTCUTS,
  visibleItems,
  type AuthorFilter,
} from './review-state';

const props = withDefaults(
  defineProps<{
    items: SuggestionItem[];
    filter?: AuthorFilter;
    currentKey?: string | null;
    collapsed?: boolean;
    busy?: boolean;
    /** Display label per raw author id; falls back to the id. */
    labels?: Record<string, string>;
  }>(),
  { filter: null, currentKey: null, collapsed: false, busy: false, labels: () => ({}) },
);
const emit = defineEmits<{
  'toggle-author': [author: string];
  'show-all': [];
  select: [key: string];
  prev: [];
  next: [];
  'decide-current': [decision: Decision];
  'decide-one': [key: string, decision: Decision];
  'decide-visible': [decision: Decision];
  'toggle-collapsed': [];
}>();

const authors = computed(() => authorsOf(props.items));
const visible = computed(() => visibleItems(props.items, props.filter));
const index = computed(() => visible.value.findIndex((v) => keyOf(v) === props.currentKey));
const name = (a: string) => props.labels[a] ?? a;
const shown = (a: string) => !props.filter || props.filter.has(a);
const label = (i: SuggestionItem) => (i.kind === 'suggestion_insert' ? 'Insert' : 'Delete');
const filterOpen = ref(false);

/** Pending bulk decision awaiting confirmation. */
const confirming = ref<Decision | null>(null);
const confirmText = computed(() => {
  const d = confirming.value;
  if (!d) return '';
  const who = [...new Set(visible.value.map((v) => name(v.author)))];
  const list = who.length > 1 ? `${who.slice(0, -1).join(', ')} and ${who.at(-1)}` : who[0];
  const n = visible.value.length;
  return `${d === 'accept' ? 'Accept' : 'Reject'} ${n} change${n === 1 ? '' : 's'} from ${list}?`;
});
function confirm() {
  if (confirming.value) emit('decide-visible', confirming.value);
  confirming.value = null;
}
const tip = (text: string, keys: string) => `${text} (${keys})`;
</script>

<template>
  <aside
    v-if="collapsed"
    class="review-rail"
    aria-label="Review (collapsed)"
    data-test="review-rail"
  >
    <button
      type="button"
      class="icon"
      data-test="expand"
      :title="tip('Show review panel', REVIEW_SHORTCUTS.toggle)"
      aria-label="Show review panel"
      @click="emit('toggle-collapsed')"
    >
      ‹
    </button>
    <span class="badge" data-test="badge" :aria-label="`${visible.length} open changes`">{{
      visible.length
    }}</span>
  </aside>
  <aside v-else class="review-panel" aria-label="Review" data-test="review-panel">
    <header class="head">
      <h2>Review</h2>
      <button
        type="button"
        class="icon"
        data-test="collapse"
        :title="tip('Hide review panel', REVIEW_SHORTCUTS.toggle)"
        aria-label="Hide review panel"
        @click="emit('toggle-collapsed')"
      >
        ›
      </button>
    </header>

    <div class="filter">
      <span id="show-from" class="muted">Show changes from</span>
      <button
        type="button"
        class="trigger"
        data-test="filter-trigger"
        aria-labelledby="show-from"
        :aria-expanded="filterOpen"
        @click="filterOpen = !filterOpen"
      >
        {{ filterSummary(authors, filter) }} ▾
      </button>
      <div v-if="filterOpen" class="menu" role="group" aria-labelledby="show-from">
        <label class="opt">
          <input
            type="checkbox"
            data-test="filter-all"
            :checked="!filter"
            @change="emit('show-all')"
          />
          All
        </label>
        <label v-for="a in authors" :key="a" class="opt" data-test="filter-option" :title="a">
          <input type="checkbox" :checked="shown(a)" @change="emit('toggle-author', a)" />
          <span class="dot" :style="{ background: authorColor(a) }" />
          <span class="name">{{ name(a) }}</span>
        </label>
      </div>
    </div>

    <div class="step">
      <button
        type="button"
        data-test="prev"
        :disabled="!visible.length"
        :title="tip('Previous change', REVIEW_SHORTCUTS.prev)"
        @click="emit('prev')"
      >
        Previous
      </button>
      <span class="counter" data-test="counter" aria-live="polite">{{
        visible.length ? `${index >= 0 ? index + 1 : 0} of ${visible.length}` : '0 of 0'
      }}</span>
      <button
        type="button"
        data-test="next"
        :disabled="!visible.length"
        :title="tip('Next change', REVIEW_SHORTCUTS.next)"
        @click="emit('next')"
      >
        Next
      </button>
    </div>
    <div class="step">
      <button
        type="button"
        class="primary"
        data-test="accept-current"
        :disabled="busy || index < 0"
        :title="tip('Accept change', REVIEW_SHORTCUTS.accept)"
        @click="emit('decide-current', 'accept')"
      >
        Accept
      </button>
      <button
        type="button"
        data-test="reject-current"
        :disabled="busy || index < 0"
        :title="tip('Reject change', REVIEW_SHORTCUTS.reject)"
        @click="emit('decide-current', 'reject')"
      >
        Reject
      </button>
    </div>

    <p v-if="!visible.length" class="muted" data-test="empty">No open suggestions.</p>
    <ul v-else class="cards">
      <li
        v-for="item in visible"
        :key="keyOf(item)"
        class="card"
        :class="{ current: keyOf(item) === currentKey }"
        data-test="item"
        :aria-current="keyOf(item) === currentKey ? 'true' : undefined"
        @click="emit('select', keyOf(item))"
      >
        <div class="who">
          <span class="dot" :style="{ background: authorColor(item.author) }" />
          <span class="name" :title="item.author">{{ name(item.author) }}</span>
          <span class="kind">{{ label(item) }}</span>
        </div>
        <p :class="item.kind === 'suggestion_delete' ? 'del' : 'ins'">{{ item.text }}</p>
        <div class="actions">
          <button
            type="button"
            data-test="accept"
            :disabled="busy"
            @click.stop="emit('decide-one', keyOf(item), 'accept')"
          >
            Accept
          </button>
          <button
            type="button"
            data-test="reject"
            :disabled="busy"
            @click.stop="emit('decide-one', keyOf(item), 'reject')"
          >
            Reject
          </button>
        </div>
      </li>
    </ul>

    <footer v-if="visible.length" class="bulk">
      <button type="button" data-test="accept-all" :disabled="busy" @click="confirming = 'accept'">
        Accept all
      </button>
      <button type="button" data-test="reject-all" :disabled="busy" @click="confirming = 'reject'">
        Reject all
      </button>
    </footer>
    <div
      v-if="confirming"
      class="confirm"
      role="alertdialog"
      aria-modal="false"
      data-test="confirm"
    >
      <p>{{ confirmText }}</p>
      <button type="button" class="primary" data-test="confirm-yes" @click="confirm">
        {{ confirming === 'accept' ? 'Accept all' : 'Reject all' }}
      </button>
      <button type="button" data-test="confirm-no" @click="confirming = null">Cancel</button>
    </div>
  </aside>
</template>

<style scoped>
.review-panel,
.review-rail {
  background: var(--ct-surface);
  border-left: 1px solid var(--ct-border);
  color: var(--ct-text);
  font-family: var(--ct-font-ui);
  font-size: var(--ct-text-sm);
  min-height: 0;
  overflow: auto;
}
.review-panel {
  width: 300px;
  box-sizing: border-box;
  padding: var(--ct-space-3);
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-3);
  position: relative;
}
.review-rail {
  width: 40px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--ct-space-2);
  padding-top: var(--ct-space-2);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
h2 {
  font-size: var(--ct-text-md);
  font-weight: var(--ct-weight-semibold);
  margin: 0;
}
button {
  font: inherit;
  color: var(--ct-text);
  background: var(--ct-surface-raised);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-sm);
  padding: var(--ct-space-1) var(--ct-space-2);
  cursor: pointer;
}
button:disabled {
  color: var(--ct-text-muted);
  cursor: default;
}
button:focus-visible {
  outline: var(--ct-focus-outline);
  outline-offset: var(--ct-focus-offset);
}
button.primary {
  background: var(--ct-accent);
  color: var(--ct-accent-contrast);
  border-color: var(--ct-accent);
}
button.primary:disabled {
  background: var(--ct-surface-raised);
  color: var(--ct-text-muted);
  border-color: var(--ct-border);
}
.icon {
  border: none;
  background: none;
  font-size: var(--ct-text-lg);
  line-height: 1;
}
.badge {
  min-width: 1.25rem;
  text-align: center;
  border-radius: var(--ct-radius-full);
  background: var(--ct-accent);
  color: var(--ct-accent-contrast);
  font-size: var(--ct-text-xs);
  padding: 0 var(--ct-space-1);
}
.filter {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--ct-space-2);
}
.trigger {
  margin-left: auto;
}
.menu {
  position: absolute;
  top: 100%;
  right: 0;
  z-index: 2;
  min-width: 12rem;
  background: var(--ct-surface-raised);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-md);
  box-shadow: var(--ct-elevation-3);
  padding: var(--ct-space-2);
}
.opt {
  display: flex;
  align-items: center;
  gap: var(--ct-space-2);
  padding: var(--ct-space-1) 0;
}
.dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: var(--ct-radius-full);
  flex: none;
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.step {
  display: flex;
  align-items: center;
  gap: var(--ct-space-2);
}
.counter {
  flex: 1;
  text-align: center;
  color: var(--ct-text-muted);
}
.cards {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-2);
}
.card {
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-md);
  background: var(--ct-paper);
  padding: var(--ct-space-2);
  cursor: pointer;
}
.card.current {
  border-color: var(--ct-accent);
  background: var(--ct-selected-bg);
}
.who {
  display: flex;
  align-items: center;
  gap: var(--ct-space-2);
}
.kind {
  margin-left: auto;
  color: var(--ct-text-muted);
  font-size: var(--ct-text-xs);
}
.card p {
  margin: var(--ct-space-1) 0;
  font-family: var(--ct-font-manuscript);
}
.ins {
  background: var(--ct-suggest-insert-bg);
  text-decoration: underline var(--ct-suggest-insert-underline);
}
.del {
  color: var(--ct-suggest-delete-text);
  background: var(--ct-suggest-delete-bg);
  text-decoration: line-through var(--ct-suggest-delete-strike);
}
.actions,
.bulk {
  display: flex;
  gap: var(--ct-space-2);
}
.muted {
  color: var(--ct-text-muted);
}
.confirm {
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-md);
  background: var(--ct-surface-raised);
  box-shadow: var(--ct-elevation-3);
  padding: var(--ct-space-3);
}
.confirm p {
  margin: 0 0 var(--ct-space-2);
}
</style>
