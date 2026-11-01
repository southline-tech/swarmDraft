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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Decision, SuggestionItem } from '@swarmdraft/editor';
import {
  authorKind,
  authorsOf,
  bulkActionLabel,
  groupChanges,
  outdatedCountForAuthor,
  REVIEW_SHORTCUTS,
  REVIEW_VIEW_CYCLE,
  viewScopeAnnouncement,
  visibleItems,
  type AuthorFilter,
  type ReviewChange,
} from './review-state';
import type { BookChapterGroup } from './review-book';
import { scrollListRowToTop } from './review-scroll';
import { authorName, type AgentName } from '../agent-names';
import { collabColor } from '../author-colors';
import {
  REVIEW_CHANGES_REGION_ID,
  focusCheckedViewOption,
  roveViewRadio,
  viewMenuTabIndex,
} from './review-panel-a11y';

const VIEW_MENU_ID = 'review-view-menu';

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
    /** Book-wide rail (#210): pre-merged changes with scoped keys. */
    bookChanges?: readonly ReviewChange[] | null;
    /** Sticky chapter headers in reading order; omit empty chapters. */
    chapterGroups?: readonly BookChapterGroup[] | null;
    /** Scroll-sync active row (#217); distinct from click selection (`currentKey`). */
    activeScrollKey?: string | null;
    /** When true, list follows manuscript scroll position. */
    follow?: boolean;
  }>(),
  {
    filter: null,
    currentKey: null,
    collapsed: false,
    busy: false,
    labels: authorName,
    loadFailed: false,
    bookChanges: null,
    chapterGroups: null,
    activeScrollKey: null,
    follow: true,
  },
);
const emit = defineEmits<{
  select: [key: string];
  prev: [];
  next: [];
  'decide-one': [key: string, decision: Decision];
  /** Keys are locked when the confirmation opens, so later arrivals are not included. */
  'decide-visible': [decision: Decision, keys: string[]];
  'toggle-collapsed': [];
  /** Single-select author view (#177); null is All. */
  'select-view': [author: string | null];
  'update:follow': [on: boolean];
}>();

const changes = computed(() =>
  props.bookChanges != null ? [...props.bookChanges] : groupChanges(props.items),
);
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
const outdatedOf = (a: string) => outdatedCountForAuthor(props.items, a);
const pendingOf = (a: string) => countOf(a);
const scopeStatus = computed(() =>
  viewScopeAnnouncement(
    props.filter,
    props.filter ? name(props.filter) : 'everyone',
    visible.value.length,
  ),
);
const triggerLabel = computed(() => {
  if (!props.filter) return 'All';
  return parts(props.filter).name;
});
const menuOpen = ref(false);
const viewFilterRoot = ref<HTMLElement | null>(null);
const viewToggle = ref<HTMLButtonElement | null>(null);
function closeViewMenu(refocus = false) {
  if (!menuOpen.value) return;
  menuOpen.value = false;
  if (refocus) void nextTick(() => viewToggle.value?.focus());
}
function onDocDown(e: MouseEvent) {
  if (viewFilterRoot.value && !viewFilterRoot.value.contains(e.target as Node))
    closeViewMenu(false);
}
watch(menuOpen, (open) => {
  if (open) {
    document.addEventListener('mousedown', onDocDown);
    void nextTick(() => {
      if (viewFilterRoot.value) focusCheckedViewOption(viewFilterRoot.value);
    });
  } else document.removeEventListener('mousedown', onDocDown);
});
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocDown));
function onViewMenuKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    closeViewMenu(true);
    return;
  }
  if (viewFilterRoot.value) roveViewRadio(e, viewFilterRoot.value);
}
function pickView(author: string | null) {
  emit('select-view', author);
  closeViewMenu(true);
}
const acceptAllLabel = computed(() =>
  bulkActionLabel('accept', props.filter, props.filter ? name(props.filter) : ''),
);
const rejectAllLabel = computed(() =>
  bulkActionLabel('reject', props.filter, props.filter ? name(props.filter) : ''),
);
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
const tip = (text: string, keys: string) => `${text} (${keys})`;

const changeByKey = computed(() => new Map(visible.value.map((c) => [c.key, c])));

const groupedVisible = computed(() => {
  if (!props.chapterGroups?.length) return null;
  const vis = changeByKey.value;
  return props.chapterGroups
    .map((g) => ({
      ...g,
      changes: g.changeKeys
        .map((k) => vis.get(k))
        .filter((c): c is (typeof visible.value)[0] => !!c),
    }))
    .filter((g) => g.changes.length);
});

const listEl = ref<HTMLElement | null>(null);
const rowRefs = new Map<string, HTMLElement>();
function setRowRef(key: string, el: unknown) {
  if (el instanceof HTMLElement) rowRefs.set(key, el);
  else rowRefs.delete(key);
}

let programmaticListScroll = false;
let followResumeTimer: ReturnType<typeof setTimeout> | undefined;
let pointerOverList = false;

function scrollListToActive(key: string | null | undefined) {
  if (!key || !props.follow || !listEl.value) return;
  const row = rowRefs.get(key);
  if (!row) return;
  programmaticListScroll = true;
  scrollListRowToTop(listEl.value, row, 8);
  const list = listEl.value;
  const end = () => {
    programmaticListScroll = false;
    list.removeEventListener('scrollend', end);
    clearTimeout(fallback);
  };
  list.addEventListener('scrollend', end, { once: true });
  const fallback = setTimeout(end, 600);
}

watch(
  () => props.activeScrollKey,
  (key) => {
    if (props.follow) void nextTick(() => scrollListToActive(key));
  },
);

function pauseFollowFromUser() {
  if (programmaticListScroll) return;
  if (props.follow) emit('update:follow', false);
  clearTimeout(followResumeTimer);
  followResumeTimer = setTimeout(() => {
    if (!pointerOverList) emit('update:follow', true);
  }, 4000);
}

function onListPointerEnter() {
  pointerOverList = true;
  clearTimeout(followResumeTimer);
}
function onListPointerLeave() {
  pointerOverList = false;
}

function onListScroll() {
  if (programmaticListScroll) return;
  pauseFollowFromUser();
}

function resumeFollow() {
  emit('update:follow', true);
  void nextTick(() => scrollListToActive(props.activeScrollKey ?? props.currentKey));
}

function onListKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'PageUp' || e.key === 'PageDown') {
    pauseFollowFromUser();
  }
  if (e.key === 'Enter') {
    const t = e.target;
    if (t instanceof HTMLElement) {
      const row = t.closest('[data-review-row-key]');
      const key = row?.getAttribute('data-review-row-key');
      if (key) {
        e.preventDefault();
        emit('select', key);
        if (row instanceof HTMLElement) row.focus();
      }
    }
  }
}

function activateChangeRow(key: string, e: Event) {
  emit('select', key);
  const el = e.currentTarget;
  if (el instanceof HTMLElement) void nextTick(() => el.focus());
}

function cardClasses(c: { key: string }) {
  return {
    current: c.key === props.currentKey,
    active: c.key === props.activeScrollKey,
  };
}

onMounted(() => {
  if (props.follow && props.activeScrollKey) scrollListToActive(props.activeScrollKey);
});
onBeforeUnmount(() => clearTimeout(followResumeTimer));
</script>

<template>
  <PanelRail
    v-if="collapsed"
    side="right"
    expand-label="Show review panel"
    :expand-title="tip('Show review panel', REVIEW_SHORTCUTS.toggle)"
    :badge="visible.length"
    :controls-id="REVIEW_CHANGES_REGION_ID"
    :panel-expanded="false"
    data-test="review-rail"
    @expand="emit('toggle-collapsed')"
  />
  <div
    v-if="collapsed"
    :id="REVIEW_CHANGES_REGION_ID"
    class="review-region-anchor"
    aria-hidden="true"
    data-test="review-region-anchor"
  />
  <aside
    v-else
    :id="REVIEW_CHANGES_REGION_ID"
    class="review-panel"
    aria-label="Review changes"
    data-test="review-panel"
  >
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
        aria-expanded="true"
        :aria-controls="REVIEW_CHANGES_REGION_ID"
        @click="emit('toggle-collapsed')"
      >
        ⇥
      </button>
    </header>

    <div
      v-if="authors.length > 1"
      ref="viewFilterRoot"
      class="view-filter"
      data-test="view-switcher"
    >
      <div id="show-from" class="lbl">Show changes from</div>
      <button
        ref="viewToggle"
        type="button"
        class="dd"
        data-test="filter-toggle"
        aria-haspopup="true"
        aria-labelledby="show-from view-trigger-label"
        :aria-expanded="menuOpen"
        :aria-controls="VIEW_MENU_ID"
        @click="menuOpen = !menuOpen"
      >
        <span id="view-trigger-label" class="cur name" data-test="filter-current">{{
          triggerLabel
        }}</span>
        <span v-if="!filter" class="cnt pill" data-test="view-count">{{ changes.length }}</span>
        <span v-else class="av sm" :style="hue(filter)" aria-hidden="true">{{
          initial(filter)
        }}</span>
        <span class="caret" aria-hidden="true">▾</span>
      </button>
      <div
        v-if="menuOpen"
        :id="VIEW_MENU_ID"
        class="sh-menu view-menu"
        role="radiogroup"
        aria-labelledby="show-from"
        data-test="view-menu"
        @keydown="onViewMenuKeydown"
      >
        <button
          type="button"
          role="radio"
          data-view-option
          data-test="view-all"
          class="view-menu__opt"
          :class="{ sel: !filter }"
          :aria-checked="!filter ? 'true' : 'false'"
          :tabindex="viewMenuTabIndex(!filter)"
          @click="pickView(null)"
        >
          <span class="check" aria-hidden="true">{{ !filter ? '✓' : '' }}</span>
          <span class="view-menu__label">All</span>
          <span class="pill cnt">{{ changes.length }}</span>
        </button>
        <button
          v-for="a in authors"
          :key="`view-${a}`"
          type="button"
          role="radio"
          data-view-option
          data-test="view-author"
          :data-author="a"
          class="view-menu__opt"
          :class="{ sel: filter === a }"
          :aria-checked="filter === a ? 'true' : 'false'"
          :tabindex="viewMenuTabIndex(filter === a)"
          @click="pickView(a)"
        >
          <span class="check" aria-hidden="true">{{ filter === a ? '✓' : '' }}</span>
          <span class="av sm" :style="hue(a)" aria-hidden="true">{{ initial(a) }}</span>
          <bdi class="name view-menu__label" dir="auto" data-test="agent-name" :title="name(a)">{{
            parts(a).name
          }}</bdi>
          <span v-if="parts(a).note" class="note" data-test="agent-note">{{ parts(a).note }}</span>
          <span class="pill">{{ authorKind(a) }}</span>
          <span class="pill cnt">{{ pendingOf(a) }}</span>
          <span v-if="outdatedOf(a)" class="pill outdated" data-test="view-outdated"
            >{{ outdatedOf(a) }} outdated</span
          >
        </button>
      </div>
      <p class="view-scope" role="status" data-test="view-scope-status">{{ scopeStatus }}</p>
      <p class="view-cycle-hint muted" data-test="view-cycle-hint">
        Cycle authors <kbd>{{ REVIEW_VIEW_CYCLE.prev }}</kbd> /
        <kbd>{{ REVIEW_VIEW_CYCLE.next }}</kbd>
      </p>
    </div>

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
    <div
      v-else
      ref="listEl"
      class="cards-scroll"
      role="listbox"
      aria-label="Tracked changes"
      data-test="review-list"
      @wheel="pauseFollowFromUser"
      @scroll="onListScroll"
      @pointerenter="onListPointerEnter"
      @pointerleave="onListPointerLeave"
      @keydown="onListKeydown"
    >
      <template v-if="groupedVisible">
        <section
          v-for="g in groupedVisible"
          :key="g.sectionId"
          class="chapter-group"
          data-test="review-chapter-group"
        >
          <h3 class="chapter-head">{{ g.label }}</h3>
          <ul class="cards">
            <li
              v-for="c in g.changes"
              :key="c.key"
              :ref="(el) => setRowRef(c.key, el)"
              class="card"
              :class="cardClasses(c)"
              :style="hue(c.author)"
              data-suggester
              data-test="item"
              :data-review-row-key="c.key"
              role="option"
              :aria-selected="c.key === currentKey ? 'true' : 'false'"
              :aria-current="c.key === props.activeScrollKey ? 'true' : undefined"
              tabindex="-1"
              @click="activateChangeRow(c.key, $event)"
            >
              <span
                v-if="c.key === props.activeScrollKey"
                class="visually-hidden"
                data-test="review-row-active"
                aria-hidden="true"
              />
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
              <p v-if="c.format" class="format" data-test="format">{{ c.format.label }}</p>
              <p v-else class="q">
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
        </section>
      </template>
      <ul v-else class="cards">
        <li
          v-for="c in visible"
          :key="c.key"
          :ref="(el) => setRowRef(c.key, el)"
          class="card"
          :class="cardClasses(c)"
          :style="hue(c.author)"
          data-suggester
          data-test="item"
          :data-review-row-key="c.key"
          role="option"
          :aria-selected="c.key === currentKey ? 'true' : 'false'"
          :aria-current="c.key === props.activeScrollKey ? 'true' : undefined"
          tabindex="-1"
          @click="activateChangeRow(c.key, $event)"
        >
          <span
            v-if="c.key === props.activeScrollKey"
            class="visually-hidden"
            data-test="review-row-active"
            aria-hidden="true"
          />
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
          <p v-if="c.format" class="format" data-test="format">{{ c.format.label }}</p>
          <p v-else class="q">
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
      <button
        v-if="!follow && props.activeScrollKey"
        type="button"
        class="follow-chip"
        data-test="review-follow"
        aria-label="Resume following manuscript"
        @click="resumeFollow"
      >
        Follow manuscript
      </button>
    </div>

    <footer v-if="visible.length" class="bulk">
      <button type="button" data-test="accept-all" :disabled="busy" @click="openConfirm('accept')">
        {{ acceptAllLabel }}
      </button>
      <button type="button" data-test="reject-all" :disabled="busy" @click="openConfirm('reject')">
        {{ rejectAllLabel }}
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
.review-region-anchor {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
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
  overflow: hidden;
  min-height: 0;
}
.author-filter {
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-md);
  margin: 0;
  padding: var(--ct-space-2);
}
.filter .menu.author-filter {
  position: absolute;
  z-index: 10;
  left: 0;
  right: 0;
  margin: 2px 0 0;
  box-shadow: var(--ct-elevation-2);
  background: var(--ct-surface-raised);
  max-height: 320px;
  overflow-y: auto;
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
.view-filter {
  position: relative;
}
.view-filter .dd {
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
.view-filter .dd .cur {
  flex: 1;
  min-width: 0;
}
.view-filter .caret {
  color: var(--ct-text-muted);
}
.view-filter .view-menu {
  position: absolute;
  left: 0;
  right: 0;
  margin: 2px 0 0;
  max-height: 320px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.view-menu__opt {
  display: flex;
  align-items: center;
  gap: var(--ct-space-2);
  width: 100%;
  min-height: var(--ct-space-12);
  padding: 0 var(--ct-space-2);
  border: none;
  border-radius: var(--ct-radius-md);
  background: none;
  color: var(--ct-text);
  font-size: var(--ct-text-md);
  text-align: left;
  cursor: pointer;
}
.view-menu__opt:hover,
.view-menu__opt:focus-visible {
  background: var(--ct-selected-bg);
}
.view-menu__opt.sel {
  background: var(--ct-selected-bg);
  font-weight: var(--ct-weight-semibold);
}
.view-menu__opt .check {
  width: 1.25rem;
  flex: none;
  text-align: center;
  color: var(--ct-accent);
  font-weight: var(--ct-weight-semibold);
}
.view-menu__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.view-menu__opt .pill.cnt {
  margin-left: auto;
}
.view-menu__opt .pill.outdated {
  color: var(--ct-warning);
  background: var(--ct-warning-bg);
  border: 1px solid color-mix(in srgb, var(--ct-warning) 35%, transparent);
}
.view-scope {
  margin: var(--ct-space-2) 0 0;
  font-size: var(--ct-text-sm);
  color: var(--ct-text);
}
.view-cycle-hint {
  margin: var(--ct-space-1) 0 0;
  font-size: var(--ct-text-xs);
}
.view-cycle-hint kbd {
  font: inherit;
  padding: 0 var(--ct-space-1);
  border-radius: var(--ct-radius-sm);
  border: 1px solid var(--ct-border);
  background: var(--ct-surface-raised);
}
.view-switcher {
  display: none;
}
.view-opt {
  display: none;
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
.cards-scroll {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-2);
}
.chapter-group {
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-2);
}
.chapter-head {
  position: sticky;
  top: 0;
  z-index: 2;
  margin: 0;
  padding: var(--ct-space-1) 0;
  font-size: var(--ct-text-xs);
  font-weight: var(--ct-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--ct-text-muted);
  background: var(--ct-surface);
  border-bottom: 1px solid var(--ct-border-subtle);
}
.card.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--ct-accent);
  border-radius: var(--ct-radius-md) 0 0 var(--ct-radius-md);
  pointer-events: none;
}
.card.active {
  box-shadow: none;
}
.follow-chip {
  position: sticky;
  bottom: var(--ct-space-2);
  align-self: center;
  margin-top: auto;
  font-size: var(--ct-text-sm);
  font-weight: var(--ct-weight-semibold);
  padding: var(--ct-space-1) var(--ct-space-3);
  border-radius: var(--ct-radius-full);
  border: 1px solid var(--ct-border);
  background: color-mix(in srgb, var(--ct-surface-raised) 88%, transparent);
  color: var(--ct-text);
  box-shadow: var(--ct-elevation-2);
  cursor: pointer;
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
  position: relative;
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
  background: color-mix(in srgb, var(--ct-accent) 12%, var(--ct-selected-bg));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ct-accent) 35%, transparent);
}
.who {
  display: flex;
  align-items: center;
  gap: var(--ct-space-2);
  font-weight: var(--ct-weight-semibold);
}
.card .format {
  margin: var(--ct-space-2) 0 var(--ct-space-2);
  font-family: var(--ct-font-ui);
  font-size: var(--ct-text-md);
  font-weight: var(--ct-weight-semibold);
  color: var(--ct-text);
  padding: var(--ct-space-2) var(--ct-space-3);
  border-radius: var(--ct-radius-sm);
  background: var(--ct-suggest-format-bg);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ct-suggester) 35%, transparent);
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
