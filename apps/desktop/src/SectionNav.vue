<script setup lang="ts">
/**
 * Parts / chapters / scenes navigation (RAD-214). Shows the outline as an indented list; select a
 * section to open it, add sections, rename (double-click or Rename), reorder with the arrow
 * buttons, or drag a row onto another (into a part/chapter that can hold it, otherwise before it).
 */
import { computed, nextTick, ref } from 'vue';
import type { Section, SectionKind } from '@coauthor/schema';
import {
  addSection,
  buildOutline,
  canNest,
  dropSection,
  moveSection,
  renameSection,
  type OutlineNode,
} from '@coauthor/editor';

const props = defineProps<{ manuscriptId: string; sections: Section[]; selectedId?: string }>();
const emit = defineEmits<{ 'update:sections': [Section[]]; select: [id: string] }>();

const KIND_LABELS: Record<SectionKind, string> = {
  front_matter: 'Front matter',
  part: 'Part',
  chapter: 'Chapter',
  scene: 'Scene',
  back_matter: 'Back matter',
};

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
  walk(buildOutline(props.sections), 0);
  return out;
});

const byId = (id?: string) => props.sections.find((s) => s.id === id);
const selected = computed(() => byId(props.selectedId));

/** Where a new section of `kind` goes, given the selection; undefined if nowhere sensible. */
function parentFor(kind: SectionKind): { parentId?: string } | undefined {
  if (!canNest(kind, undefined) || kind === 'chapter') {
    // Chapters go into the selected part (or the selection's part), else top level.
    for (let s = selected.value; s; s = byId(s.parentId))
      if (canNest(kind, s.kind)) return { parentId: s.id };
    return canNest(kind, undefined) ? {} : undefined;
  }
  return {};
}

function add(kind: SectionKind) {
  const where = parentFor(kind);
  if (!where) return;
  const next = addSection(props.sections, {
    manuscriptId: props.manuscriptId,
    kind,
    title: `New ${KIND_LABELS[kind].toLowerCase()}`,
    ...where,
  });
  emit('update:sections', next);
  const created = next.find((s) => !props.sections.some((o) => o.id === s.id));
  if (created) {
    emit('select', created.id);
    startRename(created.id, created.title);
  }
}

const editingId = ref<string>();
const draft = ref('');
function startRename(id: string, title: string) {
  editingId.value = id;
  draft.value = title;
  void nextTick(() =>
    (document.querySelector('[data-test="rename-input"]') as HTMLInputElement)?.select(),
  );
}
function commitRename() {
  const id = editingId.value;
  editingId.value = undefined;
  const title = draft.value.trim();
  if (id && title && title !== byId(id)?.title)
    emit('update:sections', renameSection(props.sections, id, title));
}

function move(delta: -1 | 1) {
  if (selected.value)
    emit('update:sections', moveSection(props.sections, selected.value.id, delta));
}

const dragId = ref<string>();
function onDrop(target: Section) {
  const id = dragId.value;
  dragId.value = undefined;
  const dragged = byId(id);
  if (!id || !dragged || id === target.id) return;
  const into = canNest(dragged.kind, target.kind);
  emit(
    'update:sections',
    dropSection(props.sections, id, into ? { parentId: target.id } : { beforeId: target.id }),
  );
}
</script>

<template>
  <nav class="section-nav" aria-label="Manuscript outline">
    <div class="actions" role="toolbar" aria-label="Outline">
      <button
        v-for="kind in ['part', 'chapter', 'scene', 'front_matter', 'back_matter'] as SectionKind[]"
        :key="kind"
        type="button"
        :data-test="`add-${kind}`"
        :disabled="!parentFor(kind)"
        @click="add(kind)"
      >
        + {{ KIND_LABELS[kind] }}
      </button>
    </div>
    <ul role="tree">
      <li
        v-for="row in rows"
        :key="row.section.id"
        role="treeitem"
        :aria-selected="row.section.id === selectedId"
        :class="['row', row.section.kind, { selected: row.section.id === selectedId }]"
        :style="{ paddingLeft: `${row.depth * 1.25 + 0.5}rem` }"
        :data-test="`section-${row.section.id}`"
        draggable="true"
        @dragstart="dragId = row.section.id"
        @dragover.prevent
        @drop.prevent="onDrop(row.section)"
        @click="emit('select', row.section.id)"
        @dblclick="startRename(row.section.id, row.section.title)"
      >
        <span class="kind">{{ KIND_LABELS[row.section.kind] }}</span>
        <input
          v-if="editingId === row.section.id"
          v-model="draft"
          data-test="rename-input"
          aria-label="Section title"
          @click.stop
          @keydown.enter="commitRename"
          @keydown.esc="editingId = undefined"
          @blur="commitRename"
        />
        <span v-else class="title">{{ row.section.title }}</span>
      </li>
    </ul>
    <div v-if="selected" class="actions" role="toolbar" aria-label="Selected section">
      <button type="button" data-test="move-up" @click="move(-1)">↑</button>
      <button type="button" data-test="move-down" @click="move(1)">↓</button>
      <button type="button" data-test="rename" @click="startRename(selected.id, selected.title)">
        Rename
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
</style>
