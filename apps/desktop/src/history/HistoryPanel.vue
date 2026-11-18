<script setup lang="ts">
import { computed, nextTick, onMounted, ref, shallowRef, watch } from 'vue';
import type {
  DraftHistoryCompare,
  DraftHistoryRestorePreview,
  HistoryFeedRow,
  HistoryFilterOption,
} from '../backend';
import {
  draftHistoryCompare,
  draftHistoryFeed,
  draftHistoryRestorePreview,
  draftMilestoneCreate,
  draftMilestoneDelete,
  draftMilestonesList,
  draftRestore,
  type DraftMilestoneRow,
} from '../backend';
import type { ManuscriptSaveView } from '../status/save-status';
import { saveStatusLabel } from '../status/save-status';
import {
  formatHistoryDayHeader,
  formatHistoryLongWhen,
  formatHistoryRowWhen,
  formatRestoreTitleWhen,
  historyDayKey,
} from './history-time';
import type { HistoryActivityTab, HistoryFilterKey } from './history-dock-state';
import OverlayAnchoredMenu from '../overlay/OverlayAnchoredMenu.vue';
import '../shells/shells.css';

const props = defineProps<{
  active: boolean;
  manuscriptId: string | null;
  wordCount?: number;
  save?: ManuscriptSaveView;
  pendingReviewCount?: number;
  authorLabel?: string;
  beforeRestore?: () => void | Promise<void>;
}>();

const emit = defineEmits<{
  restored: [toast: string];
  compare: [oid: string, data: DraftHistoryCompare, label: string];
  'close-compare': [];
  'open-suggestion': [changeId: string, sectionId: string];
}>();

const loading = ref(false);
const error = ref('');
const rows = ref<HistoryFeedRow[]>([]);
const filterOptions = ref<HistoryFilterOption[]>([]);
const activityTab = ref<HistoryActivityTab>('all');
const filter = ref<HistoryFilterKey>('all');
const filterMenu = ref(false);
const filterTrigger = ref<HTMLButtonElement | null>(null);
const milestones = ref<DraftMilestoneRow[]>([]);
const expandedBotId = ref<string | null>(null);
const focusedRowId = ref<string | null>(null);
const confirmOid = ref<string | null>(null);
const confirmPreview = ref<DraftHistoryRestorePreview | null>(null);
const compareMode = ref(false);
const compareOid = ref<string | null>(null);
const compareData = ref<DraftHistoryCompare | null>(null);
const compareLabel = ref('');
const compareSeen = shallowRef(new Set<string>());
const removeMilestoneRef = ref<string | null>(null);
const panelRoot = ref<HTMLElement | null>(null);
const heading = ref<HTMLHeadingElement | null>(null);
const cancelRestoreBtn = ref<HTMLButtonElement | null>(null);

const authorName = computed(() => props.authorLabel ?? 'You');
const saveLabel = computed(() => (props.save ? saveStatusLabel(props.save) : ''));

const currentCard = computed<HistoryFeedRow>(() => ({
  id: 'current',
  oid: '',
  kind: 'current',
  actorName: authorName.value,
  isBot: false,
  timeUnix: Math.floor(Date.now() / 1000),
  summaryTitle: 'Your book as it is now',
}));

function fallbackSummary(row: HistoryFeedRow): string {
  const n = row.suggestionCount ?? 0;
  if (n === 1) return row.chapterTitle ? `1 suggestion in ${row.chapterTitle}` : '1 suggestion';
  if (n > 1) {
    return row.chapterTitle ? `${n} suggestions in ${row.chapterTitle}` : `${n} suggestions`;
  }
  if (row.kind === 'save') return 'You saved your book';
  if (row.kind === 'authorEdit' && row.chapterTitle) return `You edited ${row.chapterTitle}`;
  if (row.kind === 'milestone' && row.milestoneName) return row.milestoneName;
  return row.summaryTitle ?? '';
}

function rowTitle(row: HistoryFeedRow): string {
  if (row.kind === 'current') return 'Your book as it is now';
  if (row.kind === 'authorEdit' && row.chapterTitle) return `You edited ${row.chapterTitle}`;
  return row.summaryTitle || fallbackSummary(row) || row.actorName;
}

function rowMatchesFilter(row: HistoryFeedRow): boolean {
  if (row.kind === 'current') return true;
  if (filter.value === 'all') return true;
  if (filter.value === 'author') return !row.isBot;
  return row.isBot && row.agentId === filter.value;
}

const filteredRows = computed(() => {
  const base =
    activityTab.value === 'milestones'
      ? rows.value.filter((r) => r.kind === 'milestone')
      : rows.value;
  return base.filter(rowMatchesFilter);
});

const groupedRows = computed(() => {
  const map = new Map<string, { label: string; rows: HistoryFeedRow[] }>();
  const list = [currentCard.value, ...filteredRows.value];
  const now = new Date();
  for (const row of list) {
    const key = row.kind === 'current' ? 'current' : historyDayKey(row.timeUnix, now);
    const label = row.kind === 'current' ? '' : formatHistoryDayHeader(row.timeUnix, now);
    if (!map.has(key)) map.set(key, { label, rows: [] });
    map.get(key)!.rows.push(row);
  }
  return [...map.values()].filter((g) => g.rows.length > 0);
});

const emptyFilter = computed(() => {
  if (filter.value === 'all') return false;
  return filteredRows.value.length === 0;
});

const emptyFilterCopy = computed(() => {
  const opt = filterOptions.value.find((o) => o.key === filter.value);
  const name = opt?.label ?? filter.value;
  return `No history from ${name}.`;
});

async function load() {
  if (!props.manuscriptId) return;
  loading.value = true;
  error.value = '';
  try {
    const feed = await draftHistoryFeed(props.manuscriptId);
    rows.value = feed.rows;
    filterOptions.value = feed.filterOptions;
    if (activityTab.value === 'milestones') {
      milestones.value = await draftMilestonesList(props.manuscriptId);
    }
  } catch (e) {
    console.error('History load failed', e);
    error.value = "Couldn't load history. Try again.";
    rows.value = [];
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.active, props.manuscriptId] as const,
  ([active]) => {
    if (active) {
      void load();
      void nextTick(() => heading.value?.focus());
    }
  },
  { immediate: true },
);

watch(activityTab, (tab) => {
  if (tab === 'milestones' && props.manuscriptId) {
    void draftMilestonesList(props.manuscriptId).then((m) => {
      milestones.value = m;
    });
  }
});

function toggleBot(row: HistoryFeedRow) {
  expandedBotId.value = expandedBotId.value === row.id ? null : row.id;
}

async function startCompare(row: HistoryFeedRow) {
  if (!props.manuscriptId || row.kind === 'current') return;
  compareOid.value = row.oid;
  compareLabel.value = `${row.actorName} · ${formatRestoreTitleWhen(row.timeUnix)}`;
  const data = await draftHistoryCompare(props.manuscriptId, row.oid);
  compareData.value = data;
  compareMode.value = true;
  emit('compare', row.oid, data, compareLabel.value);
}

function closeCompare() {
  compareMode.value = false;
  compareOid.value = null;
  compareData.value = null;
  emit('close-compare');
}

async function onRestoreClick(row: HistoryFeedRow) {
  if (row.kind === 'current' || !props.manuscriptId) return;
  const seen = compareSeen.value.has(row.oid);
  if (!seen && !compareMode.value) {
    await startCompare(row);
    compareSeen.value = new Set([...compareSeen.value, row.oid]);
    return;
  }
  const preview = await draftHistoryRestorePreview(props.manuscriptId, row.oid);
  confirmPreview.value = preview;
  confirmOid.value = row.oid;
  await nextTick(() => cancelRestoreBtn.value?.focus());
}

function cancelRestore() {
  confirmOid.value = null;
  confirmPreview.value = null;
}

async function doRestore() {
  if (!props.manuscriptId || !confirmOid.value) return;
  const label = compareLabel.value || confirmPreview.value?.titleLabel || 'this version';
  try {
    await props.beforeRestore?.();
    await draftRestore(props.manuscriptId, confirmOid.value);
    cancelRestore();
    closeCompare();
    const toast = `Restored from "${label}". A copy of your previous draft is in History as "Before restoring · ${formatRestoreTitleWhen(Math.floor(Date.now() / 1000))}".`;
    emit('restored', toast);
    await load();
  } catch (e) {
    console.error('Restore failed', e);
    error.value =
      "Couldn't restore that version. Your book wasn't changed and your edits are still here.";
    cancelRestore();
  }
}

async function addMilestone() {
  if (!props.manuscriptId) return;
  const name = window.prompt('Name this milestone');
  if (!name?.trim()) return;
  await draftMilestoneCreate(props.manuscriptId, name.trim());
  await load();
}

function askRemoveMilestone(refName: string) {
  removeMilestoneRef.value = refName;
}

async function confirmRemoveMilestone() {
  if (!props.manuscriptId || !removeMilestoneRef.value) return;
  try {
    await draftMilestoneDelete(props.manuscriptId, removeMilestoneRef.value);
    removeMilestoneRef.value = null;
    await load();
  } catch (e) {
    console.error(e);
    error.value = "Couldn't remove that milestone.";
  }
}

function onPanelKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (removeMilestoneRef.value) {
      e.preventDefault();
      removeMilestoneRef.value = null;
      return;
    }
    if (confirmOid.value) {
      e.preventDefault();
      cancelRestore();
      return;
    }
    if (compareMode.value) {
      e.preventDefault();
      closeCompare();
    }
    return;
  }
  const flat = groupedRows.value.flatMap((g) => g.rows);
  const idx = flat.findIndex((r) => r.id === focusedRowId.value);
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const next = flat[Math.min(idx + 1, flat.length - 1)];
    if (next) focusedRowId.value = next.id;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    const prev = flat[Math.max(idx - 1, 0)];
    if (prev) focusedRowId.value = prev.id;
  } else if ((e.key === 'Enter' || e.key === ' ') && idx >= 0) {
    const row = flat[idx];
    if (row?.kind === 'bot') {
      e.preventDefault();
      toggleBot(row);
    }
  }
}

function suggestionStatusLine(child: HistoryFeedRow['children'] extends infer C ? C : never) {
  const c = child as NonNullable<HistoryFeedRow['children']>[number];
  const when = formatHistoryRowWhen(c.timeUnix);
  if (c.status === 'rejected') {
    return `${c.deciderName} · ${when} · ${c.chapterTitle}`;
  }
  if (c.status === 'editedLater') {
    return `${c.deciderName} accepted this, then edited it later · ${when}`;
  }
  return `${c.deciderName} · ${when} · ${c.chapterTitle}`;
}

onMounted(() => {
  if (props.active) heading.value?.focus();
});

defineExpose({ closeCompare });
</script>

<template>
  <section
    ref="panelRoot"
    class="history-panel"
    data-test="history-panel"
    aria-labelledby="history-panel-title"
    @keydown="onPanelKeydown"
  >
    <header class="history-panel__head">
      <h2 id="history-panel-title" ref="heading" class="st-h2" tabindex="-1">History</h2>
    </header>

    <div
      v-if="compareMode && compareData"
      class="history-panel__compare"
      data-test="history-compare-side"
    >
      <p class="history-panel__compare-lead st-body">
        {{ compareLabel }}
      </p>
      <dl class="history-panel__compare-stats">
        <dt>Words then</dt>
        <dd>{{ compareData.wordCountThen.toLocaleString() }}</dd>
        <dt>Words now</dt>
        <dd>{{ compareData.wordCountNow.toLocaleString() }}</dd>
      </dl>
      <ul v-if="compareData.chapters.length" class="history-panel__chapters" role="list">
        <li v-for="ch in compareData.chapters" :key="ch.sectionId">
          {{ ch.title }}<span v-if="ch.hasChanges"> · changes</span>
        </li>
      </ul>
      <div class="history-panel__compare-actions">
        <button type="button" class="sh-btn sh-btn--secondary" @click="closeCompare">
          Close compare
        </button>
        <button
          type="button"
          class="sh-btn sh-btn--primary"
          data-test="compare-restore"
          @click="
            onRestoreClick({
              oid: compareOid!,
              id: compareOid!,
              kind: 'bot',
              actorName: compareLabel,
              isBot: true,
              timeUnix: compareData.timeUnix,
            })
          "
        >
          Restore…
        </button>
      </div>
    </div>

    <template v-else>
      <article class="history-panel__current" data-test="history-current-card">
        <h3 class="st-h3">Your book as it is now</h3>
        <p class="history-panel__meta">
          <span>{{ (wordCount ?? 0).toLocaleString() }} words</span>
          <span v-if="saveLabel">{{ saveLabel }}</span>
        </p>
        <p class="history-panel__reason st-caption">This is your book as it is now.</p>
      </article>

      <div class="history-panel__controls">
        <button
          ref="filterTrigger"
          type="button"
          class="sh-btn sh-btn--secondary sh-btn--sm"
          aria-haspopup="menu"
          :aria-expanded="filterMenu"
          aria-label="Show history from"
          data-test="history-filter"
          @click="filterMenu = !filterMenu"
        >
          From:
          {{
            filter === 'all'
              ? 'All'
              : filter === 'author'
                ? authorName
                : (filterOptions.find((o) => o.key === filter)?.label ?? filter)
          }}
        </button>
        <OverlayAnchoredMenu :open="filterMenu" :trigger="filterTrigger">
          <button
            type="button"
            class="sh-mi"
            role="menuitem"
            @click="((filter = 'all'), (filterMenu = false))"
          >
            All
          </button>
          <button
            v-for="opt in filterOptions"
            :key="opt.key"
            type="button"
            class="sh-mi"
            role="menuitem"
            @click="((filter = opt.key), (filterMenu = false))"
          >
            {{ opt.label }}
            <span v-if="opt.isBot" class="agent-tag">Bot</span>
          </button>
          <button
            type="button"
            class="sh-mi"
            role="menuitem"
            @click="((filter = 'author'), (filterMenu = false))"
          >
            {{ authorName }}
          </button>
        </OverlayAnchoredMenu>
        <div class="history-panel__activity-tabs" role="tablist" aria-label="History views">
          <button
            type="button"
            role="tab"
            class="history-panel__activity-tab"
            :aria-selected="activityTab === 'all'"
            @click="activityTab = 'all'"
          >
            All activity
          </button>
          <button
            type="button"
            role="tab"
            class="history-panel__activity-tab"
            :aria-selected="activityTab === 'milestones'"
            @click="activityTab = 'milestones'"
          >
            Milestones
          </button>
        </div>
      </div>

      <p v-if="loading" class="st-status" role="status" data-test="history-loading">
        Loading history…
      </p>
      <div v-else-if="error" class="history-panel__error-wrap">
        <p class="history-panel__error" role="alert">{{ error }}</p>
        <button type="button" class="sh-btn sh-btn--secondary" @click="load">Try again</button>
      </div>
      <p
        v-else-if="emptyFilter"
        class="history-panel__empty st-body"
        data-test="history-empty-filter"
      >
        {{ emptyFilterCopy }}
      </p>
      <div
        v-else-if="!rows.length && activityTab === 'all'"
        class="history-panel__empty"
        data-test="history-empty"
      >
        <p class="st-h3">No history yet</p>
        <p class="st-body">
          As you write and review, versions of your book will show up here. You can also add a
          milestone to mark a moment worth keeping.
        </p>
        <button
          type="button"
          class="sh-btn sh-btn--primary"
          data-test="add-milestone"
          @click="addMilestone"
        >
          + Add a milestone
        </button>
      </div>
      <div v-else class="history-panel__scroll">
        <template v-for="(group, gi) in groupedRows" :key="gi">
          <h3 v-if="group.label" class="history-panel__day">{{ group.label }}</h3>
          <ul class="history-panel__list" role="list">
            <li
              v-for="row in group.rows"
              :key="row.id"
              class="history-panel__row"
              :class="{
                'history-panel__row--current': row.kind === 'current',
                'history-panel__row--focused': focusedRowId === row.id,
              }"
              :data-test="row.kind === 'current' ? 'history-row-current' : 'history-row'"
              tabindex="-1"
              @focusin="focusedRowId = row.id"
            >
              <div class="history-panel__row-head">
                <span class="history-panel__who"
                  ><bdi dir="auto">{{ row.actorName }}</bdi></span
                >
                <span v-if="row.isBot" class="agent-tag">Bot</span>
                <span v-if="row.kind === 'milestone'" class="history-panel__tag">Milestone</span>
              </div>
              <p class="history-panel__title st-body">{{ rowTitle(row) }}</p>
              <p v-if="row.kind !== 'current'" class="history-panel__when st-caption">
                {{ formatHistoryRowWhen(row.timeUnix) }}
                <template v-if="row.suggestionCount"> · {{ fallbackSummary(row) }}</template>
              </p>
              <div v-if="row.kind === 'bot'" class="history-panel__bot">
                <button
                  type="button"
                  class="history-panel__disclosure sh-btn sh-btn--ghost sh-btn--sm"
                  :aria-expanded="expandedBotId === row.id"
                  @click="toggleBot(row)"
                >
                  {{ expandedBotId === row.id ? 'Collapse' : 'Expand' }} suggestions
                </button>
                <ul
                  v-if="expandedBotId === row.id && row.children?.length"
                  class="history-panel__children"
                  role="list"
                >
                  <li v-for="child in row.children" :key="child.changeId">
                    <button
                      type="button"
                      class="history-panel__child sh-btn sh-btn--ghost"
                      @click="emit('open-suggestion', child.changeId, child.sectionId)"
                    >
                      <span class="history-panel__child-status">{{ child.status }}</span>
                      <span class="history-panel__child-quote">"{{ child.quote }}"</span>
                      <span class="history-panel__child-meta">{{
                        suggestionStatusLine(child)
                      }}</span>
                    </button>
                  </li>
                </ul>
              </div>
              <div v-if="row.kind !== 'current'" class="history-panel__actions">
                <button
                  v-if="row.kind !== 'milestone'"
                  type="button"
                  class="sh-btn sh-btn--secondary sh-btn--sm"
                  data-test="history-compare"
                  @click="startCompare(row)"
                >
                  Compare
                </button>
                <button
                  v-if="row.kind !== 'milestone'"
                  type="button"
                  class="sh-btn sh-btn--secondary sh-btn--sm"
                  data-test="history-restore"
                  @click="onRestoreClick(row)"
                >
                  Restore…
                </button>
                <button
                  v-if="row.kind === 'milestone'"
                  type="button"
                  class="sh-btn sh-btn--secondary sh-btn--sm"
                  data-test="history-remove-milestone-row"
                  @click="askRemoveMilestone(row.milestoneName ?? row.oid)"
                >
                  Remove milestone
                </button>
              </div>
              <p v-else class="history-panel__reason st-caption">
                Compare and Restore are not offered.
              </p>
            </li>
          </ul>
        </template>
      </div>
    </template>

    <div
      v-if="confirmOid && confirmPreview"
      class="history-panel__confirm"
      role="alertdialog"
      aria-labelledby="history-restore-title"
      aria-describedby="history-restore-body"
      data-test="history-restore-confirm"
    >
      <h3 id="history-restore-title" class="st-h3">
        Restore your book from "{{ confirmPreview.titleLabel }}"?
      </h3>
      <div id="history-restore-body" class="st-body">
        <p>
          Your book will go back to how it was on
          <strong>{{ formatHistoryLongWhen(confirmPreview.restoreTimeUnix) }}</strong>
          ({{ confirmPreview.wordCount.toLocaleString() }} words).
        </p>
        <p>
          <strong>A copy of your current draft is kept first</strong>, as a milestone named "{{
            confirmPreview.keptMilestoneName
          }}". You can go back to it any time. Nothing is deleted.
        </p>
        <p v-if="confirmPreview.pendingReviewCount === 1">
          1 change still waiting for review is kept in that copy, not in the restored book.
        </p>
        <p v-else-if="confirmPreview.pendingReviewCount > 1">
          {{ confirmPreview.pendingReviewCount }} changes still waiting for review are kept in that
          copy, not in the restored book.
        </p>
        <p>The restored book will have no changes waiting for review.</p>
      </div>
      <div class="history-panel__confirm-actions">
        <button
          ref="cancelRestoreBtn"
          type="button"
          class="sh-btn sh-btn--secondary"
          @click="cancelRestore"
        >
          Cancel
        </button>
        <button
          type="button"
          class="sh-btn sh-btn--primary"
          data-test="history-restore-confirm"
          @click="doRestore"
        >
          Keep a copy and restore
        </button>
      </div>
    </div>

    <div
      v-if="removeMilestoneRef"
      class="history-panel__confirm"
      role="alertdialog"
      aria-labelledby="history-remove-ms-title"
      data-test="history-remove-milestone"
    >
      <h3 id="history-remove-ms-title" class="st-h3">Remove this milestone?</h3>
      <p class="st-body">Your book's history stays.</p>
      <div class="history-panel__confirm-actions">
        <button type="button" class="sh-btn sh-btn--secondary" @click="removeMilestoneRef = null">
          Cancel
        </button>
        <button type="button" class="sh-btn sh-btn--primary" @click="confirmRemoveMilestone">
          Remove milestone
        </button>
      </div>
    </div>
  </section>
</template>
