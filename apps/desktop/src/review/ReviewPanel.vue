<script setup lang="ts">
/**
 * Review panel (RAD-211, RAD-258, board WP 8): "Show changes from" author list, Previous/Next
 * step-through, Accept/Reject per change, and Accept all / Reject all for the visible changes
 * behind a confirmation. Human-only: accept/reject is a desktop command, never an agent tool.
 * Presentational: the host owns the filter and current change and applies decisions.
 * Authors are raw ids; `labels` only changes what is shown. A replacement (delete + insert with
 * one id) is one change.
 */
import { computed, ref } from 'vue';
import { authorColor, type Decision, type SuggestionItem } from '@coauthor/editor';
import {
  authorKind,
  authorsOf,
  groupChanges,
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
  'decide-one': [key: string, decision: Decision];
  /** Keys are locked when the confirmation opens, so later arrivals are not included. */
  'decide-visible': [decision: Decision, keys: string[]];
  'toggle-collapsed': [];
}>();

const changes = computed(() => groupChanges(props.items));
const authors = computed(() => authorsOf(changes.value));
const visible = computed(() => visibleItems(changes.value, props.filter));
const countOf = (a: string) => changes.value.filter((c) => c.author === a).length;
const index = computed(() => visible.value.findIndex((v) => v.key === props.currentKey));
const name = (a: string) => props.labels[a] ?? a;
const initial = (a: string) => (name(a).replace(/^agent:/, '')[0] ?? '?').toUpperCase();
const only = (a: string) => !!props.filter && props.filter.size === 1 && props.filter.has(a);
const shown = (a: string) => !props.filter || props.filter.has(a);
const hue = (a: string) => ({ '--ct-suggester': authorColor(a) });

/** Pending bulk decision awaiting confirmation, with the change keys it will act on. */
const confirming = ref<{ decision: Decision; keys: string[]; authors: string[] } | null>(null);
function openConfirm(decision: Decision) {
  confirming.value = {
    decision,
    keys: visible.value.map((v) => v.key),
    authors: [...new Set(visible.value.map((v) => name(v.author)))],
  };
}
const confirmText = computed(() => {
  const c = confirming.value;
  if (!c) return '';
  const who = c.authors;
  const list = who.length > 1 ? `${who.slice(0, -1).join(', ')} and ${who.at(-1)}` : who[0];
  const n = c.keys.length;
  return `${c.decision === 'accept' ? 'Accept' : 'Reject'} ${n} change${n === 1 ? '' : 's'} from ${list}?`;
});
function confirm() {
  const c = confirming.value;
  if (c) emit('decide-visible', c.decision, c.keys);
  confirming.value = null;
}
const tip = (text: string, keys: string) => `${text} (${keys})`;
</script>

<template>
  <aside
    v-if="collapsed"
    class="review-rail"
    aria-label="Review changes (collapsed)"
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
  <aside v-else class="review-panel" aria-label="Review changes" data-test="review-panel">
    <header class="head">
      <h2>Review changes</h2>
      <button
        type="button"
        class="icon"
        data-test="prev"
        aria-label="Previous change"
        :disabled="!visible.length"
        :title="tip('Previous change', REVIEW_SHORTCUTS.prev)"
        @click="emit('prev')"
      >
        ‹
      </button>
      <span class="counter" data-test="counter" aria-live="polite">{{
        visible.length ? `${index >= 0 ? index + 1 : 0} of ${visible.length}` : '0 of 0'
      }}</span>
      <button
        type="button"
        class="icon"
        data-test="next"
        aria-label="Next change"
        :disabled="!visible.length"
        :title="tip('Next change', REVIEW_SHORTCUTS.next)"
        @click="emit('next')"
      >
        ›
      </button>
      <button
        type="button"
        class="icon"
        data-test="collapse"
        :title="tip('Hide review panel', REVIEW_SHORTCUTS.toggle)"
        aria-label="Hide review panel"
        @click="emit('toggle-collapsed')"
      >
        ⇥
      </button>
    </header>

    <div class="filter" role="group" aria-labelledby="show-from">
      <div id="show-from" class="lbl">Show changes from</div>
      <button
        type="button"
        class="fo"
        :class="{ sel: !filter }"
        data-test="filter-all"
        :aria-pressed="!filter"
        @click="emit('show-all')"
      >
        <span class="check" aria-hidden="true">{{ !filter ? '✓' : '' }}</span>
        Everyone
        <span class="cnt">{{ changes.length }}</span>
      </button>
      <button
        v-for="a in authors"
        :key="a"
        type="button"
        class="fo"
        :class="{ sel: only(a), off: !shown(a) }"
        data-test="filter-option"
        :title="a"
        :aria-pressed="shown(a)"
        @click="emit('toggle-author', a)"
      >
        <span class="av sm" :style="hue(a)" aria-hidden="true">{{ initial(a) }}</span>
        <span class="name">{{ name(a) }}</span>
        <span class="pill">{{ authorKind(a) }}</span>
        <span class="cnt">{{ countOf(a) }}</span>
      </button>
    </div>

    <p v-if="!visible.length" class="muted" data-test="empty">No open suggestions.</p>
    <ul v-else class="cards">
      <li
        v-for="c in visible"
        :key="c.key"
        class="card"
        :class="{ current: c.key === currentKey }"
        :style="hue(c.author)"
        data-suggester
        data-test="item"
        :aria-current="c.key === currentKey ? 'true' : undefined"
        @click="emit('select', c.key)"
      >
        <div class="who">
          <span class="av" aria-hidden="true">{{ initial(c.author) }}</span>
          <span class="name" :title="c.author">{{ name(c.author) }}</span>
          <span class="pill">{{ authorKind(c.author) }}</span>
        </div>
        <p class="q">
          <span v-if="c.del" class="del" data-test="del">{{ c.del }}</span
          ><template v-if="c.del && c.ins">{{ ' ' }}</template
          ><span v-if="c.ins" class="ins" data-test="ins">{{ c.ins }}</span>
        </p>
        <div class="actions">
          <button
            type="button"
            class="primary"
            data-test="accept"
            :disabled="busy"
            :title="tip('Accept change', REVIEW_SHORTCUTS.accept)"
            @click.stop="emit('decide-one', c.key, 'accept')"
          >
            Accept
          </button>
          <button
            type="button"
            class="secondary"
            data-test="reject"
            :disabled="busy"
            :title="tip('Reject change', REVIEW_SHORTCUTS.reject)"
            @click.stop="emit('decide-one', c.key, 'reject')"
          >
            Reject
          </button>
        </div>
      </li>
    </ul>

    <footer v-if="visible.length" class="bulk">
      <button type="button" data-test="accept-all" :disabled="busy" @click="openConfirm('accept')">
        Accept all
      </button>
      <button type="button" data-test="reject-all" :disabled="busy" @click="openConfirm('reject')">
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
        {{ confirming.decision === 'accept' ? 'Accept all' : 'Reject all' }}
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
  width: 400px;
  box-sizing: border-box;
  padding: var(--ct-space-4);
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
  gap: var(--ct-space-1);
}
h2 {
  font-size: var(--ct-text-lg);
  font-weight: var(--ct-weight-semibold);
  margin: 0 auto 0 0;
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
button.secondary {
  background: var(--ct-surface);
  border-color: var(--ct-border-strong);
}
.icon {
  border: none;
  background: none;
  font-size: var(--ct-text-lg);
  line-height: 1;
}
.counter {
  color: var(--ct-text-muted);
  font-size: var(--ct-text-sm);
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
.lbl {
  font-size: var(--ct-text-xs);
  font-weight: var(--ct-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--ct-text-muted);
  margin-bottom: var(--ct-space-1);
}
.filter {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.fo {
  display: flex;
  align-items: center;
  gap: var(--ct-space-2);
  min-height: var(--ct-space-12);
  padding: 0 var(--ct-space-2);
  border: none;
  border-radius: var(--ct-radius-md);
  background: none;
  font-size: var(--ct-text-md);
  text-align: left;
}
.fo.sel {
  background: var(--ct-selected-bg);
  font-weight: var(--ct-weight-semibold);
}
.fo.off {
  color: var(--ct-text-muted);
}
.check {
  width: 24px;
  text-align: center;
}
.cnt {
  margin-left: auto;
  font-size: var(--ct-text-sm);
  color: var(--ct-text-muted);
  background: var(--ct-bg);
  border-radius: var(--ct-radius-full);
  padding: 2px var(--ct-space-2);
}
.av {
  width: 28px;
  height: 28px;
  border-radius: var(--ct-radius-full);
  background: var(--ct-suggester);
  color: var(--ct-accent-contrast);
  font-size: var(--ct-text-sm);
  font-weight: var(--ct-weight-semibold);
  display: grid;
  place-items: center;
  flex: none;
}
.av.sm {
  width: 24px;
  height: 24px;
}
.pill {
  font-size: var(--ct-text-xs);
  font-weight: var(--ct-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 2px var(--ct-space-2);
  border-radius: var(--ct-radius-full);
  border: 1px solid var(--ct-border-strong);
  color: var(--ct-text-muted);
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
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
  border-left: 3px solid var(--ct-suggester);
  border-radius: var(--ct-radius-md);
  background: var(--ct-surface-raised);
  padding: var(--ct-space-3) var(--ct-space-4);
  cursor: pointer;
}
.card.current {
  border-color: var(--ct-accent);
  border-left-color: var(--ct-suggester);
  background: var(--ct-selected-bg);
}
.who {
  display: flex;
  align-items: center;
  gap: var(--ct-space-2);
  font-weight: var(--ct-weight-semibold);
}
.card .q {
  margin: var(--ct-space-2) 0 var(--ct-space-3);
  font-family: var(--ct-font-manuscript);
  font-size: var(--ct-text-md);
  line-height: 1.5;
}
/* Card diff marks win over .card p and any global ins/del rules. */
.card .q .ins {
  color: var(--ct-text);
  background: var(--ct-suggest-insert-bg);
  text-decoration: underline 2px var(--ct-suggest-insert-underline) !important;
  text-underline-offset: 3px;
}
.card .q .del {
  color: var(--ct-suggest-delete-text);
  background: var(--ct-suggest-delete-bg);
  text-decoration: line-through 2px var(--ct-suggest-delete-strike) !important;
}
.actions .primary,
.actions .secondary {
  min-height: var(--ct-space-12);
  padding: 0 var(--ct-space-5);
  font-size: var(--ct-text-md);
  font-weight: var(--ct-weight-semibold);
  border-radius: var(--ct-radius-md);
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
