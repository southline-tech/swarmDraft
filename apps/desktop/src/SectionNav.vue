<script setup lang="ts">
import AppIcon from './icons/AppIcon.vue';
/**
 * Parts / chapters / scenes navigation (RAD-214). Shows the outline as an indented tree; select a
 * section to open it, add sections, rename (double-click, F2 or Rename), reorder (arrow buttons,
 * Alt+↑/↓ or drag), move into another part/chapter (Move to… or drag) and delete (with a
 * confirmation that says what happens to the sections inside).
 *
 * Every change is one all-or-nothing edit: it is validated, handed to `save` (if given), and only
 * emitted once saving succeeded. A stored outline that needed repair on load is flagged.
 */
import { computed, nextTick, ref, watch } from 'vue';
import type { Section, SectionKind } from '@coauthor/schema';
import { formatCount } from './status/wordcount';
import { errorLine } from './errors/map-error';
import {
  addSection,
  applyOutlineEdit,
  buildOutline,
  canNest,
  canPromoteChildren,
  deleteSection,
  descendantsOf,
  dropSection,
  moveSection,
  normalizeOutline,
  renameSection,
  validParents,
  type OutlineNode,
} from '@coauthor/editor';

const props = defineProps<{
  manuscriptId: string;
  sections: Section[];
  selectedId?: string;
  /** Persist a new outline; throw (or reject) to refuse it. */
  save?: (next: Section[]) => void | Promise<void>;
  /** Words per section id, read-only (#52); omitted hides the count column. */
  wordCounts?: Record<string, number>;
}>();
const emit = defineEmits<{
  'update:sections': [Section[]];
  select: [id: string];
  /** A row was clicked: the parent should move focus into that section's text (#36). */
  activate: [id: string];
}>();

const KIND_LABELS: Record<SectionKind, string> = {
  front_matter: 'Front matter',
  part: 'Part',
  chapter: 'Chapter',
  scene: 'Scene',
  back_matter: 'Back matter',
};
const ADD_KINDS: SectionKind[] = ['part', 'chapter', 'scene', 'front_matter', 'back_matter'];

const loadIssues = computed(() => normalizeOutline(props.sections).issues);
const list = computed(() => normalizeOutline(props.sections).sections);

interface Row {
  section: Section;
  depth: number;
}
const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  const walk = (nodes: OutlineNode[], depth: number) => {
    for (const { children, ...section } of nodes) {
      out.push({ section, depth });
      walk(children, depth + 1);
    }
  };
  walk(buildOutline(list.value), 0);
  return out;
});

const byId = (id?: string) => list.value.find((s) => s.id === id);
const selected = computed(() => byId(props.selectedId));

const saveError = ref<string>();
const busy = ref(false);

/** Run one edit as a transaction: validate, save, then emit; on any failure nothing changes. */
async function commit(edit: (s: Section[]) => Section[]): Promise<Section[] | undefined> {
  if (busy.value) return undefined;
  const result = applyOutlineEdit(list.value, edit);
  if (!result.ok) {
    saveError.value = result.error.message;
    return undefined;
  }
  busy.value = true;
  try {
    await props.save?.(result.sections);
  } catch (e) {
    console.error('Outline save failed', e);
    saveError.value = `Not saved: ${errorLine(e, 'save')}`;
    return undefined;
  } finally {
    busy.value = false;
  }
  saveError.value = undefined;
  emit('update:sections', result.sections);
  return result.sections;
}

/** Where a new section of `kind` goes, given the selection; undefined if nowhere sensible. */
function parentFor(kind: SectionKind): { parentId?: string } | undefined {
  if (kind === 'chapter' || !canNest(kind, undefined)) {
    for (
      let s = selected.value, seen = 0;
      s && seen < list.value.length;
      s = byId(s.parentId), seen++
    )
      if (canNest(kind, s.kind)) return { parentId: s.id };
    return canNest(kind, undefined) ? {} : undefined;
  }
  return {};
}

async function add(kind: SectionKind) {
  const where = parentFor(kind);
  if (!where) return;
  const before = new Set(list.value.map((s) => s.id));
  const next = await commit((s) =>
    addSection(s, {
      manuscriptId: props.manuscriptId,
      kind,
      title: `New ${KIND_LABELS[kind].toLowerCase()}`,
      ...where,
    }),
  );
  const created = next?.find((s) => !before.has(s.id));
  if (created) {
    select(created.id);
    startRename(created.id, created.title);
  }
}

const editingId = ref<string>();
const draft = ref('');
function startRename(id: string, title: string) {
  editingId.value = id;
  draft.value = title;
  void nextTick(() =>
    (document.querySelector('[data-test="rename-input"]') as HTMLInputElement | null)?.select(),
  );
}
function cancelRename() {
  const id = editingId.value;
  editingId.value = undefined;
  if (id) focusRow(id);
}
async function commitRename() {
  const id = editingId.value;
  if (!id) return;
  editingId.value = undefined;
  if (draft.value !== byId(id)?.title) await commit((s) => renameSection(s, id, draft.value));
  focusRow(id);
}

async function move(delta: -1 | 1, id = props.selectedId) {
  const s = byId(id);
  if (s) {
    await commit((x) => moveSection(x, s.id, delta));
    focusRow(s.id);
  }
}

const TOP = '__top__';
const parentChoices = computed(() =>
  selected.value ? validParents(list.value, selected.value.id) : [],
);
async function moveTo(value: string) {
  const s = selected.value;
  if (!s || value === '') return;
  await commit((x) => dropSection(x, s.id, value === TOP ? {} : { parentId: value }));
  focusRow(s.id);
}

const confirmingDelete = ref<string>();
const deleteDialog = ref<HTMLElement>();
const deleteCancel = ref<HTMLButtonElement>();
watch(confirmingDelete, (id, was) => {
  if (id) void nextTick(() => (deleteCancel.value ?? deleteDialog.value)?.focus());
  else if (was) focusRow(was);
});
const deleteInfo = computed(() => {
  const id = confirmingDelete.value;
  if (!id) return undefined;
  return {
    section: byId(id)!,
    inside: descendantsOf(list.value, id).length,
    canPromote: canPromoteChildren(list.value, id),
  };
});
async function confirmDelete(children: 'delete' | 'promote') {
  const id = confirmingDelete.value;
  confirmingDelete.value = undefined;
  if (!id) return;
  const rowsNow = rows.value.map((r) => r.section.id);
  const next = await commit((s) => deleteSection(s, id, { children }));
  if (next) {
    const i = rowsNow.indexOf(id);
    const fallback = next.find((s) => s.id === rowsNow[i - 1]) ?? next[0];
    if (fallback) select(fallback.id);
  }
}

const dragId = ref<string>();
async function onDrop(target: Section) {
  const id = dragId.value;
  dragId.value = undefined;
  const dragged = byId(id);
  if (!id || !dragged || id === target.id) return;
  const into = canNest(dragged.kind, target.kind);
  await commit((s) => dropSection(s, id, into ? { parentId: target.id } : { beforeId: target.id }));
}

// Keyboard: roving focus over the visible rows.
function select(id: string) {
  emit('select', id);
}
/** Mouse click on a row: select it and hand focus to the editor. Not while renaming it. */
function activate(id: string) {
  select(id);
  if (editingId.value !== id) emit('activate', id);
}
function focusRow(id: string) {
  void nextTick(() =>
    (
      document.querySelector(`[data-test="section-${CSS.escape(id)}"]`) as HTMLElement | null
    )?.focus(),
  );
}
function onKey(e: KeyboardEvent, row: Row) {
  if (editingId.value) return;
  const ids = (isFront(row) ? rows : visibleRows).value.map((r) => r.section.id);
  const i = ids.indexOf(row.section.id);
  const go = (j: number) => {
    const id = ids[Math.max(0, Math.min(ids.length - 1, j))];
    if (id) {
      select(id);
      focusRow(id);
    }
  };
  const handlers: Record<string, () => void> = {
    ArrowDown: () => (e.altKey ? void move(1, row.section.id) : go(i + 1)),
    ArrowUp: () => (e.altKey ? void move(-1, row.section.id) : go(i - 1)),
    Home: () => go(0),
    End: () => go(ids.length - 1),
    ArrowLeft: () => row.section.parentId && go(ids.indexOf(row.section.parentId)),
    // Rows are always expanded, so Right goes to the first child when there is one.
    ArrowRight: () => {
      const child = rows.value.find((r) => r.section.parentId === row.section.id);
      if (child) go(ids.indexOf(child.section.id));
    },
    Enter: () => (select(row.section.id), startRename(row.section.id, row.section.title)),
    F2: () => startRename(row.section.id, row.section.title),
    Delete: () => (confirmingDelete.value = row.section.id),
  };
  const h = handlers[e.key];
  if (h) {
    e.preventDefault();
    h();
  }
}
/** UI shell (#52): top-level front matter collapses into one group row (display state only). */
const frontOpen = ref(false);
const isFront = (r: Row) => r.depth === 0 && r.section.kind === 'front_matter';
const frontCount = computed(() => rows.value.filter(isFront).length);
const showFront = computed(
  () => frontOpen.value || rows.value.some((r) => isFront(r) && r.section.id === props.selectedId),
);
const visibleRows = computed(() =>
  showFront.value ? rows.value : rows.value.filter((r) => !isFront(r)),
);

const focusId = computed(() => props.selectedId ?? rows.value[0]?.section.id);
</script>

<template>
  <nav class="section-nav" aria-label="Manuscript outline">
    <p v-if="loadIssues.length" role="alert" class="warn" data-test="outline-repaired">
      The stored outline had {{ loadIssues.length }} problem(s) (for example a section inside
      itself) and is shown repaired. Your next change saves the repaired outline.
    </p>
    <p v-if="saveError" role="alert" class="warn" data-test="save-error">{{ saveError }}</p>
    <ul role="tree" aria-label="Sections">
      <li v-if="frontCount" role="none" class="group-row">
        <button
          type="button"
          class="group"
          data-test="front-matter-group"
          :aria-expanded="showFront"
          @click="frontOpen = !frontOpen"
        >
          <span aria-hidden="true">{{ showFront ? '▾' : '▸' }}</span> Front matter
          <span class="count">{{ frontCount }}</span>
        </button>
      </li>
      <li
        v-for="row in rows"
        v-show="showFront || !isFront(row)"
        :key="row.section.id"
        role="treeitem"
        :aria-level="row.depth + 1"
        :aria-label="`${KIND_LABELS[row.section.kind]}: ${row.section.title || 'Untitled'}`"
        :aria-selected="row.section.id === selectedId"
        :tabindex="row.section.id === focusId ? 0 : -1"
        :class="['row', row.section.kind, { selected: row.section.id === selectedId }]"
        :style="{ paddingLeft: `${row.depth * 1.25 + 0.5}rem` }"
        :data-test="`section-${row.section.id}`"
        draggable="true"
        @dragstart="dragId = row.section.id"
        @dragover.prevent
        @drop.prevent="onDrop(row.section)"
        @click="activate(row.section.id)"
        @dblclick="startRename(row.section.id, row.section.title)"
        @keydown="onKey($event, row)"
      >
        <input
          v-if="editingId === row.section.id"
          v-model="draft"
          data-test="rename-input"
          aria-label="Section title"
          @click.stop
          @keydown.stop.enter="commitRename"
          @keydown.stop.esc="cancelRename"
          @blur="commitRename"
        />
        <span v-else class="title">{{ row.section.title || 'Untitled' }}</span>
        <span
          v-if="wordCounts"
          class="count"
          data-test="word-count"
          :aria-label="`${wordCounts[row.section.id] ?? 0} words`"
          >{{ wordCounts[row.section.id] ? formatCount(wordCounts[row.section.id]!) : '—' }}</span
        >
      </li>
    </ul>
    <button
      type="button"
      class="new-chapter"
      data-test="new-chapter"
      :disabled="busy || parentFor('chapter') === undefined"
      title="Add a chapter"
      @click="add('chapter')"
    >
      <span aria-hidden="true">+</span> New chapter
    </button>
    <details class="add-more">
      <summary data-test="add-more">More sections…</summary>
      <div class="actions" role="toolbar" aria-label="Add section">
        <button
          v-for="kind in ADD_KINDS"
          :key="kind"
          type="button"
          :data-test="`add-${kind}`"
          :disabled="busy || !parentFor(kind)"
          @click="add(kind)"
        >
          <AppIcon name="plus" />
          {{ KIND_LABELS[kind] }}
        </button>
      </div>
    </details>
    <div v-if="selected" class="actions" role="toolbar" aria-label="Selected section">
      <button
        type="button"
        class="icon-btn"
        data-test="move-up"
        aria-label="Move up"
        title="Move up"
        :disabled="busy"
        @click="move(-1)"
      >
        <AppIcon name="arrow-up" />
      </button>
      <button
        type="button"
        class="icon-btn"
        data-test="move-down"
        aria-label="Move down"
        title="Move down"
        :disabled="busy"
        @click="move(1)"
      >
        <AppIcon name="arrow-down" />
      </button>
      <button
        type="button"
        data-test="rename"
        :disabled="busy"
        @click="startRename(selected.id, selected.title)"
      >
        Rename
      </button>
      <label>
        Move to
        <select
          data-test="move-to"
          :disabled="busy"
          @change="moveTo(($event.target as HTMLSelectElement).value)"
        >
          <option value="">…</option>
          <option v-for="p in parentChoices" :key="p?.id ?? TOP" :value="p?.id ?? TOP">
            {{ p ? `${KIND_LABELS[p.kind]}: ${p.title || 'Untitled'}` : 'Top level' }}
          </option>
        </select>
      </label>
      <button
        type="button"
        data-test="delete"
        :disabled="busy"
        @click="confirmingDelete = selected.id"
      >
        Delete
      </button>
    </div>
    <div
      v-if="deleteInfo"
      ref="deleteDialog"
      role="alertdialog"
      aria-modal="true"
      aria-label="Delete section"
      class="confirm"
      data-test="confirm-delete"
      tabindex="-1"
      @keydown.esc.stop.prevent="confirmingDelete = undefined"
    >
      <p>
        Delete this section<template v-if="deleteInfo.inside">
          and the {{ deleteInfo.inside }} section(s) inside it</template
        >? Its text, comments and suggestions (including pending bot suggestions) can't be
        recovered.
      </p>
      <!-- Safest first; Cancel takes focus when the dialog opens. -->
      <button
        ref="deleteCancel"
        type="button"
        data-test="confirm-delete-cancel"
        @click="confirmingDelete = undefined"
      >
        Cancel
      </button>
      <button
        v-if="deleteInfo.inside"
        type="button"
        data-test="confirm-delete-promote"
        :disabled="!deleteInfo.canPromote"
        :title="deleteInfo.canPromote ? '' : 'What is inside cannot move up a level'"
        @click="confirmDelete('promote')"
      >
        Delete only this, keep what is inside
      </button>
      <button
        type="button"
        class="danger"
        data-test="confirm-delete-all"
        @click="confirmDelete('delete')"
      >
        Delete
      </button>
    </div>
  </nav>
</template>

<style scoped>
.icon-btn,
.actions button {
  display: inline-flex;
  align-items: center;
  gap: var(--ct-space-1);
}
.confirm .danger {
  background: var(--ct-danger);
  border-color: var(--ct-danger);
  color: var(--ct-danger-bg);
}
.section-nav ul {
  list-style: none;
  margin: 0.5rem 0;
  padding: 0;
}
.row {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  padding: 0.2rem 0.5rem;
  cursor: pointer;
}
.row.selected {
  background: var(--ct-selected-bg);
  color: var(--ct-text);
}
.row .title {
  flex: 1;
  min-width: 0;
}
.count {
  margin-left: auto;
  font-size: var(--ct-text-xs);
  color: var(--ct-text-muted);
  font-variant-numeric: tabular-nums;
}
.new-chapter {
  display: flex;
  gap: var(--ct-space-2);
  align-items: center;
  width: 100%;
  padding: var(--ct-space-1) var(--ct-space-2);
  border: 0;
  background: transparent;
  color: var(--ct-text-muted);
  font: inherit;
  font-size: var(--ct-text-sm);
  cursor: pointer;
}
.new-chapter:disabled {
  cursor: default;
  opacity: 0.5;
}
.row:focus-visible {
  outline: var(--ct-focus-outline);
  outline-offset: calc(var(--ct-focus-offset) * -1);
}
.group-row {
  list-style: none;
}
.group {
  display: flex;
  gap: var(--ct-space-2);
  width: 100%;
  padding: 0.25rem 0.5rem;
  border: 0;
  background: none;
  color: var(--ct-text-muted);
  font: inherit;
  font-size: var(--ct-text-sm);
  text-align: left;
  cursor: pointer;
}
.group .count {
  margin-left: auto;
}
.add-more summary {
  color: var(--ct-text-muted);
  font-size: var(--ct-text-sm);
  cursor: pointer;
}
.kind {
  font-size: var(--ct-text-xs);
  color: var(--ct-text-muted);
  min-width: 5.5rem;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}
.warn {
  color: var(--ct-warning);
}
.confirm {
  border: 1px solid var(--ct-danger);
  border-radius: var(--ct-radius-md);
  padding: var(--ct-space-2);
  margin-top: var(--ct-space-2);
}
</style>
