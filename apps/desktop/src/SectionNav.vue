<script setup lang="ts">
/**
 * Parts / chapters navigation (RAD-214). Shows the outline as an indented tree; select a
 * section to open it, rename (double-click or F2), reorder (Alt+↑/↓ or drag), move into another
 * part (context menu or drag) and delete (with confirmation). Row actions live in the context menu
 * (#108); keyboard: Shift+F10 / Menu, F2, Delete.
 *
 * Every change is one all-or-nothing edit: it is validated, handed to `save` (if given), and only
 * emitted once saving succeeded. A stored outline that needed repair on load is flagged.
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import './shells/shells.css';
import type { NumberingStyle, Section, SectionKind } from '@coauthor/schema';
import { NUMBERING_STYLE_LABELS, NUMBERING_STYLES } from './numbering-style-labels';
import { formatCount } from './status/wordcount';
import AppIcon from './icons/AppIcon.vue';
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
  /** Book-wide numbering display (#111); shown in the outline menu when set. */
  numberingStyle?: NumberingStyle;
}>();
const emit = defineEmits<{
  'update:sections': [Section[]];
  select: [id: string];
  /** A row was clicked: the parent should move focus into that section's text (#36). */
  activate: [id: string];
  numberingStyle: [style: NumberingStyle];
}>();

const KIND_LABELS: Record<SectionKind, string> = {
  front_matter: 'Front matter',
  part: 'Part',
  chapter: 'Chapter',
  back_matter: 'Back matter',
};

/** Brett #109: default front/back matter catalog and which front rows show as placeholders. */
const FRONT_MATTER_CATALOG = [
  'Title page',
  'Copyright',
  'Dedication',
  'Epigraph',
  'Contents',
] as const;
const BACK_MATTER_CATALOG = ['Acknowledgements', 'About the author', 'Also by'] as const;
const DEFAULT_FRONT_PLACEHOLDERS = new Set<string>(['Title page', 'Copyright', 'Contents']);

function normalizeMatterTitle(title: string) {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}
function catalogTitle(title: string, catalog: readonly string[]) {
  const n = normalizeMatterTitle(title);
  return catalog.find((c) => normalizeMatterTitle(c) === n);
}
function matterSlug(title: string) {
  return normalizeMatterTitle(title).replace(/[^a-z0-9]+/g, '-');
}
function topLevelMatter(sections: Section[], kind: 'front_matter' | 'back_matter') {
  return sections.filter((s) => !s.parentId && s.kind === kind);
}
function hasCatalogMatter(
  sections: Section[],
  title: string,
  kind: 'front_matter' | 'back_matter',
) {
  return topLevelMatter(sections, kind).some((s) => catalogTitle(s.title, [title]) === title);
}
const loadIssues = computed(() => normalizeOutline(props.sections).issues);
const list = computed(() => normalizeOutline(props.sections).sections);

interface Row {
  section: Section;
  depth: number;
}
type DisplayEntry =
  | { kind: 'section'; section: Section; depth: number }
  | {
      kind: 'placeholder';
      title: string;
      matterKind: 'front_matter' | 'back_matter';
      depth: number;
    };

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

/** Map catalog front-matter slots to existing sections (title match; first front row fills Title page). */
function frontCatalogSlots(sections: Section[]) {
  const front = topLevelMatter(sections, 'front_matter');
  const unmatched = [...front];
  const filled = new Map<string, Section>();
  for (const title of FRONT_MATTER_CATALOG) {
    const i = unmatched.findIndex((s) => catalogTitle(s.title, [title]) === title);
    if (i >= 0) {
      filled.set(title, unmatched[i]!);
      unmatched.splice(i, 1);
    }
  }
  if (!filled.has('Title page') && unmatched.length) filled.set('Title page', unmatched.shift()!);
  return { filled, extras: unmatched };
}

/** Reading-order outline rows plus default front-matter placeholders (#109). */
const displayEntries = computed<DisplayEntry[]>(() => {
  const out: DisplayEntry[] = [];
  const { filled, extras } = frontCatalogSlots(list.value);
  for (const title of FRONT_MATTER_CATALOG) {
    const section = filled.get(title);
    if (section) out.push({ kind: 'section', section, depth: 0 });
    else if (DEFAULT_FRONT_PLACEHOLDERS.has(title))
      out.push({ kind: 'placeholder', title, matterKind: 'front_matter', depth: 0 });
  }
  for (const section of extras) out.push({ kind: 'section', section, depth: 0 });
  for (const row of rows.value) {
    if (row.depth === 0 && row.section.kind === 'front_matter') continue;
    out.push({ kind: 'section', section: row.section, depth: row.depth });
  }
  return out;
});

function entryKey(entry: DisplayEntry) {
  return entry.kind === 'section' ? entry.section.id : `placeholder:${entry.title}`;
}

const newMatterOptions = computed(() => {
  const opts: { title: string; matterKind: 'front_matter' | 'back_matter' }[] = [];
  for (const title of FRONT_MATTER_CATALOG) {
    if (!hasCatalogMatter(list.value, title, 'front_matter'))
      opts.push({ title, matterKind: 'front_matter' });
  }
  for (const title of BACK_MATTER_CATALOG) {
    if (!hasCatalogMatter(list.value, title, 'back_matter'))
      opts.push({ title, matterKind: 'back_matter' });
  }
  return opts;
});

const byId = (id?: string) => list.value.find((s) => s.id === id);

const saveError = ref<string>();
const busy = ref(false);

/** Run one edit as a transaction: validate, save, then emit; on any failure nothing changes. */
async function commit(
  edit: (s: Section[]) => Section[],
  opts?: { preserveUndoBanner?: boolean },
): Promise<Section[] | undefined> {
  if (busy.value) return undefined;
  if (!opts?.preserveUndoBanner) undoSections.value = null;
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

/** Insert a sibling of the same kind immediately after `id`, then rename (#108 comment). */
function siblingInsertAfter(id: string): { beforeId?: string; parentId?: string } | undefined {
  const s = byId(id);
  if (!s) return undefined;
  const i = rows.value.findIndex((r) => r.section.id === id);
  if (i < 0) return undefined;
  const depth = rows.value[i]!.depth;
  for (let j = i + 1; j < rows.value.length; j++) {
    const r = rows.value[j]!;
    if (r.depth < depth) break;
    if (r.depth === depth && r.section.parentId === s.parentId) return { beforeId: r.section.id };
  }
  return s.parentId ? { parentId: s.parentId } : {};
}

/** Add a catalog front/back matter section at the correct outline slot (#109). */
async function addCatalogMatter(title: string, matterKind: 'front_matter' | 'back_matter') {
  closeMenu();
  newMenuOpen.value = false;
  if (hasCatalogMatter(list.value, title, matterKind)) return;
  const beforeIds = new Set(list.value.map((x) => x.id));
  const next = await commit((cur) =>
    addSection(cur, {
      manuscriptId: props.manuscriptId,
      kind: matterKind,
      title,
    }),
  );
  const created = next?.find((x) => !beforeIds.has(x.id));
  if (created) {
    undoSections.value = null;
    if (matterKind === 'front_matter') frontOpen.value = true;
    select(created.id);
    activate(created.id);
  }
}

async function addSiblingAfter(id: string) {
  closeMenu();
  const s = byId(id);
  const where = siblingInsertAfter(id);
  if (!s || !where) return;
  const beforeIds = new Set(list.value.map((x) => x.id));
  const next = await commit((cur) => {
    let sections = addSection(cur, {
      manuscriptId: props.manuscriptId,
      kind: s.kind,
      title: `New ${KIND_LABELS[s.kind].toLowerCase()}`,
      ...(s.parentId ? { parentId: s.parentId } : {}),
    });
    const created = sections.find((x) => !beforeIds.has(x.id));
    if (!created) return sections;
    return dropSection(sections, created.id, where);
  });
  const created = next?.find((x) => !beforeIds.has(x.id));
  if (created) {
    undoSections.value = null;
    select(created.id);
    startRename(created.id, created.title);
  }
}

const undoSections = ref<Section[] | null>(null);
async function undoDelete() {
  const snap = undoSections.value;
  if (!snap) return;
  const next = await commit(() => snap.map((x) => ({ ...x })), { preserveUndoBanner: true });
  if (next) undoSections.value = null;
}

async function move(delta: -1 | 1, id = props.selectedId) {
  const s = byId(id);
  if (s) {
    await commit((x) => moveSection(x, s.id, delta));
    focusRow(s.id);
  }
}

function sectionIdOrder(sections: Section[]) {
  return sections.map((s) => s.id).join('\0');
}
function canMove(id: string, delta: -1 | 1) {
  return sectionIdOrder(moveSection(list.value, id, delta)) !== sectionIdOrder(list.value);
}
function moveBlocked(id: string, delta: -1 | 1) {
  return busy.value || !canMove(id, delta);
}

const menuFor = ref<string>();
const menuAt = ref<{ x: number; y: number }>();
const menuRoot = ref<HTMLElement>();
const moveSubOpen = ref(false);
const partChoices = computed(() => {
  const id = menuFor.value;
  if (!id) return [] as Section[];
  return validParents(list.value, id).filter((p): p is Section => !!p && p.kind === 'part');
});

function closeMenu() {
  const id = menuFor.value;
  menuFor.value = undefined;
  menuAt.value = undefined;
  moveSubOpen.value = false;
  if (id) focusRow(id);
}
function menuAnchorForRow(id: string) {
  const el = document.querySelector(
    `[data-test="section-${CSS.escape(id)}"]`,
  ) as HTMLElement | null;
  const r = el?.getBoundingClientRect();
  return { x: r?.left ?? 0, y: (r?.bottom ?? 0) + 4 };
}
function openMenu(id: string, anchor: { x: number; y: number }) {
  select(id);
  menuFor.value = id;
  menuAt.value = anchor;
  moveSubOpen.value = false;
  void nextTick(() => menuRoot.value?.querySelector<HTMLElement>('[role=menuitem]')?.focus());
}
function onRowContextMenu(e: MouseEvent, id: string) {
  e.preventDefault();
  openMenu(id, { x: e.clientX, y: e.clientY });
}
const newMenuOpen = ref(false);
const newMenuWrap = ref<HTMLElement>();

function onPointerDownCapture(e: MouseEvent) {
  const t = e.target as Node;
  if (menuFor.value && !menuRoot.value?.contains(t)) closeMenu();
  if (newMenuOpen.value && !newMenuWrap.value?.contains(t)) newMenuOpen.value = false;
}
onMounted(() => document.addEventListener('mousedown', onPointerDownCapture, true));
onUnmounted(() => document.removeEventListener('mousedown', onPointerDownCapture, true));

function onMenuKey(e: KeyboardEvent) {
  const items = [...(menuRoot.value?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])];
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
  }
}
function menuEdit(id: string) {
  menuFor.value = undefined;
  menuAt.value = undefined;
  moveSubOpen.value = false;
  activate(id);
}
function menuRename(id: string) {
  closeMenu();
  startRename(id, byId(id)?.title ?? '');
}
async function menuMove(delta: -1 | 1, id: string) {
  closeMenu();
  await move(delta, id);
}
async function menuMoveToPart(id: string, partId: string) {
  closeMenu();
  await commit((x) => dropSection(x, id, { parentId: partId }));
  focusRow(id);
}
function menuDelete(id: string) {
  closeMenu();
  confirmingDelete.value = id;
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
  undoSections.value = list.value.map((x) => ({ ...x }));
  const rowsNow = rows.value.map((r) => r.section.id);
  const next = await commit((s) => deleteSection(s, id, { children }), {
    preserveUndoBanner: true,
  });
  if (next) {
    const i = rowsNow.indexOf(id);
    const fallback = next.find((s) => s.id === rowsNow[i - 1]) ?? next[0];
    if (fallback) select(fallback.id);
  } else undoSections.value = null;
}

const dragId = ref<string>();
type DropEdge = 'before' | 'after' | 'into';
const dropHint = ref<{ targetId: string; edge: DropEdge } | null>(null);

function onDragStart(id: string) {
  dragId.value = id;
  dropHint.value = null;
}
function onDragEnd() {
  dragId.value = undefined;
  dropHint.value = null;
}
function dropEdgeFor(e: DragEvent, row: Row): DropEdge | null {
  const id = dragId.value;
  if (!id || id === row.section.id) return null;
  const dragged = byId(id);
  if (!dragged) return null;
  const el = e.currentTarget as HTMLElement;
  const h = el.getBoundingClientRect().height || 1;
  const y = e.clientY - el.getBoundingClientRect().top;
  const nest = canNest(dragged.kind, row.section.kind);
  if (nest && y >= h * 0.25 && y <= h * 0.75) return 'into';
  return y < h / 2 ? 'before' : 'after';
}
function onDragOver(e: DragEvent, row: Row) {
  e.preventDefault();
  const edge = dropEdgeFor(e, row);
  if (!edge) {
    dropHint.value = null;
    return;
  }
  dropHint.value = { targetId: row.section.id, edge };
}
function onDragLeave(e: DragEvent, row: Row) {
  const el = e.currentTarget as HTMLElement;
  if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
  if (dropHint.value?.targetId === row.section.id) dropHint.value = null;
}
function dropTargetFor(target: Section, edge: DropEdge) {
  if (edge === 'into') return { parentId: target.id };
  if (edge === 'before') return { beforeId: target.id };
  const flat = rows.value;
  const i = flat.findIndex((r) => r.section.id === target.id);
  if (i < 0) return { parentId: target.parentId };
  const depth = flat[i]!.depth;
  let j = i + 1;
  while (j < flat.length && flat[j]!.depth > depth) j += 1;
  if (j < flat.length) return { beforeId: flat[j]!.section.id };
  return { parentId: target.parentId };
}
async function onDrop(e: DragEvent, target: Section, row: Row) {
  const id = dragId.value;
  const hint = dropHint.value;
  const dragged = byId(id);
  if (!id || !dragged || id === target.id) return;
  const edge =
    dropEdgeFor(e, row) ??
    (hint?.targetId === target.id
      ? hint.edge
      : canNest(dragged.kind, target.kind)
        ? 'into'
        : 'before');
  const next = await commit((s) => {
    const moved = dropSection(s, id, dropTargetFor(target, edge));
    if (sectionIdOrder(moved) === sectionIdOrder(s)) {
      throw new Error('That move is not allowed here.');
    }
    return moved;
  });
  if (next) {
    dragId.value = undefined;
    dropHint.value = null;
  }
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
function onKey(e: KeyboardEvent, entry: DisplayEntry) {
  if (editingId.value) return;
  if (entry.kind === 'placeholder') {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void addCatalogMatter(entry.title, entry.matterKind);
    }
    return;
  }
  const row: Row = { section: entry.section, depth: entry.depth };
  if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
    e.preventDefault();
    openMenu(row.section.id, menuAnchorForRow(row.section.id));
    return;
  }
  const allSectionIds = displayEntries.value
    .filter((e): e is Extract<DisplayEntry, { kind: 'section' }> => e.kind === 'section')
    .map((e) => e.section.id);
  const keys = isFrontEntry(entry) ? allSectionIds : navigableKeys.value;
  const i = keys.indexOf(row.section.id);
  const go = (j: number) => {
    const key = keys[Math.max(0, Math.min(keys.length - 1, j))];
    if (!key) return;
    if (key.startsWith('placeholder:')) {
      focusEntryKey(key);
      return;
    }
    activate(key);
    focusRow(key);
  };
  const handlers: Record<string, () => void> = {
    ArrowDown: () => (e.altKey ? void move(1, row.section.id) : go(i + 1)),
    ArrowUp: () => (e.altKey ? void move(-1, row.section.id) : go(i - 1)),
    Home: () => go(0),
    End: () => go(keys.length - 1),
    ArrowLeft: () => row.section.parentId && go(keys.indexOf(row.section.parentId)),
    // Rows are always expanded, so Right goes to the first child when there is one.
    ArrowRight: () => {
      const child = rows.value.find((r) => r.section.parentId === row.section.id);
      if (child) go(keys.indexOf(child.section.id));
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
const isFrontEntry = (entry: DisplayEntry) =>
  entry.depth === 0 &&
  (entry.kind === 'placeholder'
    ? entry.matterKind === 'front_matter'
    : entry.section.kind === 'front_matter');
const frontCount = computed(
  () => rows.value.filter((r) => r.depth === 0 && r.section.kind === 'front_matter').length,
);
const hasFrontZone = computed(
  () =>
    frontCount.value > 0 ||
    displayEntries.value.some((e) => e.kind === 'placeholder' && e.matterKind === 'front_matter'),
);
const showFront = computed(
  () =>
    frontOpen.value ||
    rows.value.some(
      (r) =>
        r.depth === 0 && r.section.kind === 'front_matter' && r.section.id === props.selectedId,
    ),
);
const navigableEntries = computed(() =>
  showFront.value ? displayEntries.value : displayEntries.value.filter((e) => !isFrontEntry(e)),
);
const navigableKeys = computed(() =>
  navigableEntries.value
    .filter((e): e is Extract<DisplayEntry, { kind: 'section' }> => e.kind === 'section')
    .map((e) => e.section.id),
);

function focusEntryKey(key: string) {
  void nextTick(() =>
    (document.querySelector(`[data-entry="${CSS.escape(key)}"]`) as HTMLElement | null)?.focus(),
  );
}

const focusId = computed(
  () => props.selectedId ?? displayEntries.value.find((e) => e.kind === 'section')?.section.id,
);
</script>

<template>
  <nav class="section-nav" aria-label="Manuscript outline">
    <p v-if="loadIssues.length" role="alert" class="warn" data-test="outline-repaired">
      The stored outline had {{ loadIssues.length }} problem(s) (for example a section inside
      itself) and is shown repaired. Your next change saves the repaired outline.
    </p>
    <p v-if="saveError" role="alert" class="warn" data-test="save-error">{{ saveError }}</p>
    <ul role="tree" aria-label="Sections">
      <li v-if="hasFrontZone" role="none" class="group-row">
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
      <template v-for="entry in displayEntries" :key="entryKey(entry)">
        <li
          v-if="entry.kind === 'placeholder'"
          v-show="showFront || !isFrontEntry(entry)"
          role="treeitem"
          :aria-level="entry.depth + 1"
          :aria-label="`Add ${entry.title}`"
          :tabindex="entryKey(entry) === focusId ? 0 : -1"
          class="row row--placeholder front_matter"
          :style="{ paddingLeft: `${entry.depth * 1.25 + 0.5}rem` }"
          :data-test="`matter-placeholder-${matterSlug(entry.title)}`"
          :data-entry="entryKey(entry)"
          @click="addCatalogMatter(entry.title, entry.matterKind)"
          @keydown="onKey($event, entry)"
        >
          <span class="placeholder-icon" aria-hidden="true"
            ><AppIcon name="book" class="placeholder-icon__glyph"
          /></span>
          <span class="placeholder-plus" aria-hidden="true"
            ><AppIcon name="plus" class="placeholder-icon__glyph"
          /></span>
          <span class="title placeholder-label">Add {{ entry.title }}</span>
        </li>
        <li
          v-else
          v-show="showFront || !isFrontEntry(entry)"
          role="treeitem"
          :aria-level="entry.depth + 1"
          :aria-label="`${KIND_LABELS[entry.section.kind]}: ${entry.section.title || 'Untitled'}`"
          :aria-selected="entry.section.id === selectedId"
          :tabindex="entry.section.id === focusId ? 0 : -1"
          :class="[
            'row',
            entry.section.kind,
            {
              selected: entry.section.id === selectedId,
              'row--drop-into': dropHint?.targetId === entry.section.id && dropHint.edge === 'into',
            },
          ]"
          :style="{ paddingLeft: `${entry.depth * 1.25 + 0.5}rem` }"
          :data-test="`section-${entry.section.id}`"
          :data-entry="entryKey(entry)"
          draggable="true"
          @dragstart="onDragStart(entry.section.id)"
          @dragend="onDragEnd"
          @dragover="onDragOver($event, { section: entry.section, depth: entry.depth })"
          @dragleave="onDragLeave($event, { section: entry.section, depth: entry.depth })"
          @drop.prevent="
            onDrop($event, entry.section, { section: entry.section, depth: entry.depth })
          "
          @click="activate(entry.section.id)"
          @contextmenu="onRowContextMenu($event, entry.section.id)"
          @dblclick="startRename(entry.section.id, entry.section.title)"
          @keydown="onKey($event, entry)"
        >
          <span
            v-if="dropHint?.targetId === entry.section.id && dropHint.edge === 'before'"
            class="drop-line drop-line--before"
            data-test="drop-line-before"
            aria-hidden="true"
          />
          <span
            v-if="dropHint?.targetId === entry.section.id && dropHint.edge === 'after'"
            class="drop-line drop-line--after"
            data-test="drop-line-after"
            aria-hidden="true"
          />
          <input
            v-if="editingId === entry.section.id"
            v-model="draft"
            data-test="rename-input"
            aria-label="Section title"
            @click.stop
            @keydown.stop.enter="commitRename"
            @keydown.stop.esc="cancelRename"
            @blur="commitRename"
          />
          <span v-else class="title">{{ entry.section.title || 'Untitled' }}</span>
          <span
            v-if="wordCounts"
            class="count"
            data-test="word-count"
            :aria-label="`${wordCounts[entry.section.id] ?? 0} words`"
            >{{
              wordCounts[entry.section.id] ? formatCount(wordCounts[entry.section.id]!) : '—'
            }}</span
          >
        </li>
      </template>
    </ul>
    <div v-if="newMatterOptions.length" ref="newMenuWrap" class="outline-new">
      <button
        type="button"
        class="outline-new__btn"
        data-test="outline-new"
        :aria-expanded="newMenuOpen"
        aria-haspopup="menu"
        @click="newMenuOpen = !newMenuOpen"
      >
        + New
      </button>
      <div
        v-if="newMenuOpen"
        class="sh-menu outline-new__menu"
        role="menu"
        aria-label="Add section"
        data-test="outline-new-menu"
      >
        <button
          v-for="opt in newMatterOptions"
          :key="`${opt.matterKind}-${opt.title}`"
          type="button"
          role="menuitem"
          tabindex="-1"
          class="sh-mi"
          :data-test="`outline-new-${matterSlug(opt.title)}`"
          @click="addCatalogMatter(opt.title, opt.matterKind)"
        >
          {{ opt.title }}
        </button>
      </div>
    </div>
    <label v-if="numberingStyle" class="numbering-style" data-test="outline-numbering-style">
      <span class="numbering-style__label">Number display</span>
      <select
        data-test="outline-numbering-select"
        :value="numberingStyle"
        :disabled="busy"
        @change="
          emit('numberingStyle', ($event.target as HTMLSelectElement).value as NumberingStyle)
        "
      >
        <option v-for="s in NUMBERING_STYLES" :key="s" :value="s">
          {{ NUMBERING_STYLE_LABELS[s] }}
        </option>
      </select>
    </label>
    <Teleport to="body">
      <div
        v-if="menuFor && menuAt"
        ref="menuRoot"
        class="sh-menu"
        role="menu"
        aria-label="Section actions"
        data-test="outline-context-menu"
        :style="{ left: `${menuAt.x}px`, top: `${menuAt.y}px` }"
        @keydown="onMenuKey"
        @contextmenu.prevent
      >
        <button
          type="button"
          role="menuitem"
          tabindex="-1"
          class="sh-mi"
          data-test="outline-ctx-edit"
          @click="menuEdit(menuFor)"
        >
          Edit
        </button>
        <button
          type="button"
          role="menuitem"
          tabindex="-1"
          class="sh-mi"
          data-test="outline-ctx-rename"
          :aria-disabled="busy ? 'true' : undefined"
          @click="!busy && menuRename(menuFor)"
        >
          <span class="sh-mi-lead" aria-hidden="true"
            ><AppIcon name="pencil" class="outline-ctx-icon"
          /></span>
          Rename<span class="sh-k">F2</span>
        </button>
        <button
          type="button"
          role="menuitem"
          tabindex="-1"
          class="sh-mi"
          data-test="outline-ctx-add"
          :aria-disabled="busy ? 'true' : undefined"
          @click="!busy && addSiblingAfter(menuFor)"
        >
          <span class="sh-mi-lead" aria-hidden="true"
            ><AppIcon name="plus" class="outline-ctx-icon"
          /></span>
          Add
        </button>
        <div class="sh-sep" role="separator" />
        <button
          type="button"
          role="menuitem"
          tabindex="-1"
          class="sh-mi"
          data-test="outline-ctx-move-up"
          :aria-disabled="moveBlocked(menuFor, -1) ? 'true' : undefined"
          @click="!moveBlocked(menuFor, -1) && menuMove(-1, menuFor)"
        >
          <span class="sh-mi-lead" aria-hidden="true"
            ><AppIcon name="arrow-up" class="outline-ctx-icon"
          /></span>
          Move up
        </button>
        <button
          type="button"
          role="menuitem"
          tabindex="-1"
          class="sh-mi"
          data-test="outline-ctx-move-down"
          :aria-disabled="moveBlocked(menuFor, 1) ? 'true' : undefined"
          @click="!moveBlocked(menuFor, 1) && menuMove(1, menuFor)"
        >
          <span class="sh-mi-lead" aria-hidden="true"
            ><AppIcon name="arrow-down" class="outline-ctx-icon"
          /></span>
          Move down
        </button>
        <div
          class="move-to-part"
          @mouseenter="moveSubOpen = true"
          @mouseleave="moveSubOpen = false"
        >
          <button
            type="button"
            role="menuitem"
            tabindex="-1"
            class="sh-mi"
            :class="{ 'sh-open': moveSubOpen }"
            aria-haspopup="menu"
            :aria-expanded="moveSubOpen"
            data-test="outline-ctx-move-to-part"
            :aria-disabled="busy || !partChoices.length ? 'true' : undefined"
            @click="!(busy || !partChoices.length) && (moveSubOpen = !moveSubOpen)"
            @keydown.right.prevent="moveSubOpen = true"
          >
            <span class="sh-mi-lead" aria-hidden="true"
              ><AppIcon name="folder" class="outline-ctx-icon"
            /></span>
            Move to Part…<span class="sh-k">›</span>
          </button>
          <div
            v-if="moveSubOpen && partChoices.length"
            class="sh-menu sh-sub"
            role="menu"
            aria-label="Move to part"
          >
            <button
              v-for="p in partChoices"
              :key="p.id"
              type="button"
              role="menuitem"
              tabindex="-1"
              class="sh-mi"
              :data-test="`outline-ctx-part-${p.id}`"
              @click="menuMoveToPart(menuFor, p.id)"
            >
              {{ p.title || 'Untitled' }}
            </button>
          </div>
        </div>
        <div class="sh-sep" role="separator" />
        <button
          type="button"
          role="menuitem"
          tabindex="-1"
          class="sh-mi danger"
          data-test="outline-ctx-delete"
          :aria-disabled="busy ? 'true' : undefined"
          @click="!busy && menuDelete(menuFor)"
        >
          <span class="sh-mi-lead" aria-hidden="true"
            ><AppIcon name="trash" class="outline-ctx-icon outline-ctx-icon--danger"
          /></span>
          Delete
        </button>
      </div>
    </Teleport>
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
        >? You can undo right after deleting.
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
    <p v-if="undoSections" class="undo-delete" role="status" data-test="outline-undo-delete">
      Section deleted.
      <button type="button" class="sh-btn" data-test="outline-undo-delete-btn" @click="undoDelete">
        Undo
      </button>
    </p>
  </nav>
</template>

<style scoped>
.section-nav {
  color: var(--ct-text);
  background: var(--ct-surface);
}
.move-to-part {
  position: relative;
}
.sh-mi-lead {
  display: inline-flex;
  width: 16px;
  flex: none;
  align-items: center;
  justify-content: center;
}
.outline-ctx-icon {
  color: var(--ct-text-muted);
}
.outline-ctx-icon--danger {
  color: var(--ct-danger);
}
.sh-mi.danger {
  color: var(--ct-danger);
}
.sh-mi.danger:hover:not([aria-disabled='true']),
.sh-mi.danger:focus:not([aria-disabled='true']) {
  background: var(--ct-danger-bg);
  color: var(--ct-danger);
}
.undo-delete {
  margin: var(--ct-space-2) 0 0;
  font-size: var(--ct-text-sm);
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
  position: relative;
}
.drop-line {
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--ct-accent);
  pointer-events: none;
  z-index: 1;
}
.drop-line--before {
  top: 0;
}
.drop-line--after {
  bottom: 0;
}
.row--drop-into {
  box-shadow: inset 0 0 0 2px var(--ct-accent);
}
.row:hover:not(.selected) {
  background: var(--ct-hover-bg);
}
.row.selected {
  background: var(--ct-selected-bg);
  color: var(--ct-text);
}
.row.selected .count {
  color: var(--ct-text-muted);
}
.row--placeholder {
  color: var(--ct-text-muted);
}
.row--placeholder .placeholder-label {
  flex: 1;
  min-width: 0;
}
.placeholder-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex: none;
  border: 1px dashed var(--ct-border-strong);
  border-radius: var(--ct-radius-sm);
  color: var(--ct-text-muted);
}
.placeholder-plus {
  display: inline-flex;
  width: 16px;
  flex: none;
  align-items: center;
  justify-content: center;
  opacity: 0;
  color: var(--ct-text-muted);
}
.row--placeholder:hover .placeholder-plus,
.row--placeholder:focus-visible .placeholder-plus {
  opacity: 1;
}
.placeholder-icon__glyph {
  width: 12px;
  height: 12px;
}
.row .title {
  flex: 1;
  min-width: 0;
}
.outline-new {
  position: relative;
  margin: var(--ct-space-2) var(--ct-space-2) 0;
}
.outline-new__btn {
  width: 100%;
  padding: 0.25rem 0.5rem;
  border: 0;
  border-radius: var(--ct-radius-md);
  background: none;
  color: var(--ct-text-muted);
  font: inherit;
  font-size: var(--ct-text-sm);
  text-align: left;
  cursor: pointer;
}
.outline-new__btn:hover,
.outline-new__btn:focus-visible {
  background: var(--ct-hover-bg);
  color: var(--ct-text);
  outline: var(--ct-focus-outline);
  outline-offset: calc(var(--ct-focus-offset) * -1);
}
.outline-new__menu {
  position: absolute;
  left: 0;
  right: 0;
  top: 100%;
  margin-top: var(--ct-space-1);
  z-index: 20;
  max-height: 12rem;
  overflow: auto;
}
.count {
  margin-left: auto;
  font-size: var(--ct-text-xs);
  color: var(--ct-text-muted);
  font-variant-numeric: tabular-nums;
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
.numbering-style {
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-1);
  margin: var(--ct-space-2) var(--ct-space-2) 0;
  font-size: var(--ct-text-sm);
}
.numbering-style__label {
  color: var(--ct-text-muted);
}
.numbering-style select {
  font: inherit;
  color: var(--ct-text);
  background: var(--ct-surface);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-md);
  padding: var(--ct-space-1) var(--ct-space-2);
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
