<script setup lang="ts">
/**
 * Review panel (RAD-211, RAD-258, board WP 8): "Show changes from" author list, Previous/Next
 * step-through, Accept/Reject per change, and Accept all / Reject all for the visible changes
 * behind a confirmation. Human-only: accept/reject is a desktop command, never an agent tool.
 * Presentational: the host owns the filter and current change and applies decisions.
 * Authors are raw ids; `labels` only changes what is shown. A replacement (delete + insert with
 * one id) is one change.
 */
import EmptyState from '../shells/EmptyState.vue';
import ReasonLine from '../shells/ReasonLine.vue';
import PanelRail from '../desk/PanelRail.vue';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { Decision, SuggestionItem } from '@coauthor/editor';
import {
  authorKind,
  authorsOf,
  authorVisibleInFilter,
  filterSummary,
  groupChanges,
  REVIEW_SHORTCUTS,
  visibleItems,
  type AuthorFilter,
} from './review-state';
import { authorName, type AgentName } from '../agent-names';
import { collabColor } from '../author-colors';

const props = withDefaults(
  defineProps<{
    items: SuggestionItem[];
    filter?: AuthorFilter;
    currentKey?: string | null;
    collapsed?: boolean;
    busy?: boolean;
    /** Display name for a raw author id (decisions and the filter still key on the id). */
    labels?: (author: string) => AgentName;
    /** The section failed to load: never claim it is empty (that would look like data loss). */
    loadFailed?: boolean;
  }>(),
  {
    filter: null,
    currentKey: null,
    collapsed: false,
    busy: false,
    labels: authorName,
    loadFailed: false,
  },
);
const emit = defineEmits<{
  /** Show only this author's changes (raw id). */
  'show-only': [author: string];
  'show-all': [];
  select: [key: string];
  prev: [];
  next: [];
  'decide-one': [key: string, decision: Decision];
  /** Keys are locked when the confirmation opens, so later arrivals are not included. */
  'decide-visible': [decision: Decision, keys: string[]];
  'toggle-collapsed': [];
  /** wp8 (#67): multi-author filter toggles (raw id). */
  'toggle-author': [author: string];
}>();

const changes = computed(() => groupChanges(props.items));
const authors = computed(() => authorsOf(changes.value));
const visible = computed(() => visibleItems(changes.value, props.filter));
const countOf = (a: string) => changes.value.filter((c) => c.author === a).length;
const index = computed(() => visible.value.findIndex((v) => v.key === props.currentKey));
const parts = (a: string) => props.labels(a);
const name = (a: string) => {
  const n = parts(a);
  return n.note ? `${n.name} ${n.note}` : n.name;
};
const initial = (a: string) => (parts(a).name[0] ?? '?').toUpperCase();
const only = (a: string) => !!props.filter && props.filter.size === 1 && props.filter.has(a);
/** The one author shown, or null for All (or a multi-author filter set elsewhere). */
const selected = computed(() => authors.value.find(only) ?? null);

/** "Show changes from" dropdown (single choice: All or one author). */
const menuOpen = ref(false);
const root = ref<HTMLElement | null>(null);
function choose(a: string | null) {
  menuOpen.value = false;
  if (a === null) emit('show-all');
  else emit('show-only', a);
}
function filterMenuOptions(): HTMLElement[] {
  const menu = root.value?.querySelector('[data-test=filter-menu]');
  if (!menu) return [];
  return [...menu.querySelectorAll('[role=option]')] as HTMLElement[];
}
function activateFilterOption(el: HTMLElement) {
  if (el.dataset.test === 'filter-all') choose(null);
  else if (el.dataset.filterAuthor) choose(el.dataset.filterAuthor);
}
function onFilterMenuKeydown(e: KeyboardEvent) {
  const items = filterMenuOptions();
  if (!items.length) return;
  const active = document.activeElement as HTMLElement;
  const i = items.indexOf(active);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  } else if (e.key === ' ') {
    if (i >= 0) {
      e.preventDefault();
      activateFilterOption(active);
    }
  }
}
function onDocDown(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) menuOpen.value = false;
}
watch(menuOpen, (open) => {
  if (open) {
    document.addEventListener('mousedown', onDocDown);
    void nextTick(() => filterMenuOptions()[0]?.focus());
  } else document.removeEventListener('mousedown', onDocDown);
});
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocDown));
/** Theme-aware author color: a --ct-collab-N token keyed by the raw author id, never the name. */
const hue = (a: string) => ({ '--ct-suggester': collabColor(a) });

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
function onAuthorFilterChange(e: Event) {
  const t = e.target;
  if (!(t instanceof HTMLInputElement) || t.type !== 'checkbox') return;
  const author = t.dataset.author;
  if (author) emit('toggle-author', author);
}
const tip = (text: string, keys: string) => `${text} (${keys})`;
</script>

<template>
  <PanelRail
    v-if="collapsed"
    side="right"
    expand-label="Show review panel"
    :expand-title="tip('Show review panel', REVIEW_SHORTCUTS.toggle)"
    :badge="visible.length"
    data-test="review-rail"
    @expand="emit('toggle-collapsed')"
  />
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

    <div ref="root" class="filter" @keydown.escape.stop="menuOpen = false">
      <div id="show-from" class="lbl">Show changes from</div>
      <button
        type="button"
        class="dd"
        data-test="filter-toggle"
        aria-haspopup="listbox"
        aria-labelledby="show-from filter-current"
        :aria-expanded="menuOpen"
        @click="menuOpen = !menuOpen"
      >
        <span id="filter-current" class="cur" data-test="filter-current">
          <template v-if="selected">
            <span class="av sm" :style="hue(selected)" aria-hidden="true">{{
              initial(selected)
            }}</span>
            <bdi class="name" dir="auto" :title="name(selected)">{{ name(selected) }}</bdi>
            <span class="pill">{{ authorKind(selected) }}</span>
          </template>
          <span v-else class="name">{{ filter ? 'Some authors' : 'All' }}</span>
        </span>
        <span class="cnt">{{ visible.length }}</span>
        <span class="caret" aria-hidden="true">▾</span>
      </button>
      <ul
        v-if="menuOpen"
        class="menu"
        role="listbox"
        aria-labelledby="show-from"
        data-test="filter-menu"
        @keydown="onFilterMenuKeydown"
      >
        <li
          role="option"
          class="fo"
          :class="{ sel: !filter }"
          data-test="filter-all"
          :aria-selected="!filter"
          tabindex="0"
          @click="choose(null)"
          @keydown.enter.prevent="choose(null)"
        >
          <span class="check" aria-hidden="true">{{ !filter ? '✓' : '' }}</span>
          <span class="name">All</span>
          <span class="cnt">{{ changes.length }}</span>
        </li>
        <li
          v-for="a in authors"
          :key="a"
          role="option"
          class="fo"
          :class="{ sel: only(a) }"
          data-test="filter-option"
          :data-filter-author="a"
          :aria-selected="only(a)"
          tabindex="0"
          @click="choose(a)"
          @keydown.enter.prevent="choose(a)"
        >
          <span class="check" aria-hidden="true">{{ only(a) ? '✓' : '' }}</span>
          <span class="av sm" :style="hue(a)" aria-hidden="true">{{ initial(a) }}</span>
          <bdi class="name" dir="auto" data-test="agent-name" :title="name(a)">{{
            parts(a).name
          }}</bdi>
          <span v-if="parts(a).note" class="note" data-test="agent-note">{{ parts(a).note }}</span>
          <span class="pill">{{ authorKind(a) }}</span>
          <span class="cnt">{{ countOf(a) }}</span>
        </li>
      </ul>
    </div>

    <fieldset
      v-if="authors.length > 1"
      class="author-filter"
      data-test="step-authors"
      @change="onAuthorFilterChange"
    >
      <legend class="lbl">Show changes from</legend>
      <p class="author-filter__summary" data-test="filter-summary">
        {{ filterSummary(authors, filter) }}
      </p>
      <label v-for="a in authors" :key="`af-${a}`" class="author-filter__row">
        <input
          type="checkbox"
          data-test="author-filter"
          :data-author="a"
          :checked="authorVisibleInFilter(filter, a)"
        />
        <span class="av sm" :style="hue(a)" aria-hidden="true">{{ initial(a) }}</span>
        <bdi class="name" dir="auto">{{ parts(a).name }}</bdi>
        <span class="cnt">{{ countOf(a) }}</span>
      </label>
    </fieldset>

    <p v-if="!changes.length && loadFailed" class="muted" data-test="empty-load-failed">
      Suggestions couldn't be loaded for this section.
    </p>
    <EmptyState
      v-else-if="!changes.length"
      data-test="empty"
      icon="sparkle"
      tone="success"
      title="Nothing to review"
      text="When your writing assistant suggests a change, it will show up here for you to keep or skip."
    />
    <p v-else-if="!visible.length" class="muted" data-test="empty-filtered">
      No suggestions from this author. Choose All to see the rest.
    </p>
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
          <bdi class="name" dir="auto" data-test="agent-name" :title="name(c.author)">{{
            parts(c.author).name
          }}</bdi>
          <span v-if="parts(c.author).note" class="note" data-test="agent-note">{{
            parts(c.author).note
          }}</span>
          <span class="pill">{{ authorKind(c.author) }}</span>
        </div>
        <p class="q">
          <span v-if="c.del" class="del" data-test="del">{{ c.del }}</span
          ><template v-if="c.del && c.ins">{{ ' ' }}</template
          ><span v-if="c.ins" class="ins" data-test="ins">{{ c.ins }}</span>
        </p>
        <div v-if="authorKind(c.author) === 'Bot' && c.reason" class="reason" @click.stop>
          <ReasonLine :reason="c.reason" />
        </div>
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
.review-panel {
  background: var(--ct-surface);
  border-left: 1px solid var(--ct-border);
  color: var(--ct-text);
  font-family: var(--ct-font-ui);
  font-size: var(--ct-text-sm);
  min-height: 0;
}
.review-panel {
  width: 400px;
  box-sizing: border-box;
  padding: var(--ct-space-4);
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-3);
  position: relative;
  overflow: visible;
}
.author-filter {
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-md);
  margin: 0;
  padding: var(--ct-space-2);
}
.author-filter__summary {
  margin: 0 0 var(--ct-space-2);
  color: var(--ct-text-muted);
  font-size: var(--ct-text-xs);
}
.author-filter__row {
  display: flex;
  align-items: center;
  gap: var(--ct-space-2);
  padding: 2px 0;
  cursor: pointer;
}
.author-filter__row .cnt {
  margin-left: auto;
  color: var(--ct-text-muted);
  font-size: var(--ct-text-xs);
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
  position: relative;
}
.dd {
  display: flex;
  align-items: center;
  gap: var(--ct-space-2);
  width: 100%;
  min-height: var(--ct-space-12);
  padding: 0 var(--ct-space-2);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-md);
  background: var(--ct-surface);
  color: var(--ct-text);
  font-size: var(--ct-text-md);
  text-align: left;
}
.dd .cur {
  display: flex;
  align-items: center;
  gap: var(--ct-space-2);
  min-width: 0;
  flex: 1;
}
.dd .cnt {
  margin-left: 0;
}
.caret {
  color: var(--ct-text-muted);
}
.menu {
  position: absolute;
  z-index: 10;
  left: 0;
  right: 0;
  margin: 2px 0 0;
  padding: var(--ct-space-1);
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--ct-surface-raised);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-md);
  box-shadow: var(--ct-elevation-2);
  max-height: 320px;
  overflow-y: auto;
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.note {
  color: var(--ct-text-muted);
  font-size: var(--ct-text-sm);
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
  cursor: pointer;
}
.fo:hover,
.fo:focus-visible {
  background: var(--ct-selected-bg);
}
.fo.sel {
  background: var(--ct-selected-bg);
  font-weight: var(--ct-weight-semibold);
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
  margin: var(--ct-space-2) 0 var(--ct-space-2);
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
.card .reason {
  margin-bottom: var(--ct-space-3);
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
