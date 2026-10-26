<script setup lang="ts">
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
  /** If set, outline edits are turned off and this explains why (shown as a notice). */
  locked?: string;
}>();
const emit = defineEmits<{ 'update:sections': [Section[]]; select: [id: string] }>();

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
  if (busy.value || props.locked) return undefined;
  const result = applyOutlineEdit(list.value, edit);
  if (!result.ok) {
    saveError.value = result.error.message;
    return undefined;
  }
  busy.value = true;
  try {
    await props.save?.(result.sections);
  } catch (e) {
    saveError.value = `Not saved: ${e instanceof Error ? e.message : String(e)}`;
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
  if (props.locked) return;
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
function focusRow(id: string) {
  void nextTick(() =>
    (
      document.querySelector(`[data-test="section-${CSS.escape(id)}"]`) as HTMLElement | null
    )?.focus(),
  );
}
function onKey(e: KeyboardEvent, row: Row) {
  if (editingId.value) return;
  const ids = rows.value.map((r) => r.section.id);
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
const focusId = computed(() => props.selectedId ?? rows.value[0]?.section.id);
</script>

<template>
  <nav class="section-nav" aria-label="Manuscript outline">
    <p v-if="loadIssues.length" role="alert" class="warn" data-test="outline-repaired">
      The stored outline had {{ loadIssues.length }} problem(s) (for example a section inside
      itself) and is shown repaired. Your next change saves the repaired outline.
    </p>
    <p v-if="locked" class="note" data-test="outline-locked">{{ locked }}</p>
    <p v-if="saveError" role="alert" class="warn" data-test="save-error">{{ saveError }}</p>
    <div class="actions" role="toolbar" aria-label="Add section">
      <button
        v-for="kind in ADD_KINDS"
        :key="kind"
        type="button"
        :data-test="`add-${kind}`"
        :title="locked"
        :disabled="!!locked || busy || !parentFor(kind)"
        @click="add(kind)"
      >
        + {{ KIND_LABELS[kind] }}
      </button>
    </div>
    <ul role="tree" aria-label="Sections">
      <li
        v-for="row in rows"
        :key="row.section.id"
        role="treeitem"
        :aria-level="row.depth + 1"
        :aria-selected="row.section.id === selectedId"
        :tabindex="row.section.id === focusId ? 0 : -1"
        :class="['row', row.section.kind, { selected: row.section.id === selectedId }]"
        :style="{ paddingLeft: `${row.depth * 1.25 + 0.5}rem` }"
        :data-test="`section-${row.section.id}`"
        :draggable="!locked"
        @dragstart="dragId = row.section.id"
        @dragover.prevent
        @drop.prevent="onDrop(row.section)"
        @click="select(row.section.id)"
        @dblclick="startRename(row.section.id, row.section.title)"
        @keydown="onKey($event, row)"
      >
        <span class="kind">{{ KIND_LABELS[row.section.kind] }}</span>
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
      </li>
    </ul>
    <div v-if="selected" class="actions" role="toolbar" aria-label="Selected section">
      <button
        type="button"
        data-test="move-up"
        :title="locked"
        :disabled="!!locked || busy"
        @click="move(-1)"
      >
        ↑
      </button>
      <button
        type="button"
        data-test="move-down"
        :title="locked"
        :disabled="!!locked || busy"
        @click="move(1)"
      >
        ↓
      </button>
      <button
        type="button"
        data-test="rename"
        :title="locked"
        :disabled="!!locked || busy"
        @click="startRename(selected.id, selected.title)"
      >
        Rename
      </button>
      <label>
        Move to
        <select
          data-test="move-to"
          :title="locked"
          :disabled="!!locked || busy"
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
        :title="locked"
        :disabled="!!locked || busy"
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
        Delete {{ KIND_LABELS[deleteInfo.section.kind].toLowerCase() }} “{{
          deleteInfo.section.title || 'Untitled'
        }}”<template v-if="deleteInfo.inside">
          and the {{ deleteInfo.inside }} section(s) inside it</template
        >? Its text is deleted too.
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
      <button type="button" data-test="confirm-delete-all" @click="confirmDelete('delete')">
        Delete{{ deleteInfo.inside ? ` all ${deleteInfo.inside + 1}` : '' }}
      </button>
    </div>
  </nav>
</template>

<style scoped>
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
  background: #e6eefc;
}
.row:focus-visible {
  outline: 2px solid #3b6fd8;
}
.kind {
  font-size: 0.75rem;
  color: #666;
  min-width: 5.5rem;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}
.warn {
  color: #8a3b00;
}
.confirm {
  border: 1px solid #c33;
  padding: 0.5rem;
  margin-top: 0.5rem;
}
</style>
