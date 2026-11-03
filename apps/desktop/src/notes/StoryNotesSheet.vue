<script setup lang="ts">
/**
 * Story notes bottom sheet over the center editor only (#277).
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type * as Y from 'yjs';
import type { Section } from '@swarmdraft/schema';
import { APP_OVERLAY_LAYER, ensureOverlayLayer } from '../overlay/layer';
import { loadStoryNotesSheetHeight, saveStoryNotesSheetHeight } from './prefs';
import StoryNotesPanel from './StoryNotesPanel.vue';
import NoteEditModal from './NoteEditModal.vue';
import type { NoteMeta } from './doc';

const MIN_H = 240;
const DEFAULT_RATIO = 0.4;
const MAX_RATIO = 0.7;
const RESIZE_STEP = 24;

const props = defineProps<{
  notesDoc: Y.Doc;
  outline: Section[];
  readonly?: boolean;
  humanAuthor: { id: string; name: string };
  anchorSelector?: string;
}>();

const emit = defineEmits<{
  close: [];
  'select-section': [sectionId: string];
  'sheet-height': [px: number];
}>();

const sheetRoot = ref<HTMLElement | null>(null);
const separator = ref<HTMLElement | null>(null);
const overlayReady = ref(false);
const bounds = shallowRef<DOMRect | null>(null);
const heightPx = ref(320);
let resizeObserver: ResizeObserver | undefined;

const modalOpen = ref(false);
const editingId = ref<string | null>(null);
const modalReturnFocus = ref<HTMLElement | null>(null);

function anchorEl(): Element | null {
  const sel = props.anchorSelector ?? '[data-test="editor-stack"]';
  return document.querySelector(sel);
}

function clampHeight(h: number, columnH: number): number {
  const maxH = Math.max(MIN_H, Math.floor(columnH * MAX_RATIO));
  return Math.min(maxH, Math.max(MIN_H, h));
}

function defaultHeight(columnH: number): number {
  const stored = loadStoryNotesSheetHeight();
  const base = stored ?? Math.floor(columnH * DEFAULT_RATIO);
  return clampHeight(base, columnH);
}

function measureBounds() {
  const el = anchorEl();
  if (!el) return;
  bounds.value = el.getBoundingClientRect();
  const columnH = bounds.value.height;
  if (columnH > 0) {
    heightPx.value = clampHeight(heightPx.value || defaultHeight(columnH), columnH);
    emit('sheet-height', heightPx.value);
  }
}

function onResizeStep(delta: number) {
  const columnH = bounds.value?.height ?? window.innerHeight;
  const next = clampHeight(heightPx.value + delta, columnH);
  if (next === heightPx.value) return;
  heightPx.value = next;
  saveStoryNotesSheetHeight(next);
  emit('sheet-height', next);
}

let dragStartY = 0;
let dragStartH = 0;

function onSeparatorPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  dragStartY = e.clientY;
  dragStartH = heightPx.value;
  const target = e.currentTarget as HTMLElement;
  target.setPointerCapture(e.pointerId);
  const onMove = (ev: PointerEvent) => {
    const dy = dragStartY - ev.clientY;
    const columnH = bounds.value?.height ?? window.innerHeight;
    const next = clampHeight(dragStartH + dy, columnH);
    heightPx.value = next;
    emit('sheet-height', next);
  };
  const onUp = (ev: PointerEvent) => {
    target.releasePointerCapture(ev.pointerId);
    saveStoryNotesSheetHeight(heightPx.value);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function onSeparatorKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
    e.preventDefault();
    onResizeStep(RESIZE_STEP);
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
    e.preventDefault();
    onResizeStep(-RESIZE_STEP);
  }
}

function onSheetKeydown(e: KeyboardEvent) {
  if (modalOpen.value) return;
  if (e.key !== 'Escape') return;
  if (!sheetRoot.value?.contains(document.activeElement)) return;
  e.preventDefault();
  e.stopPropagation();
  requestClose();
}

function requestClose() {
  emit('close');
}

function openCreate(fromEl?: HTMLElement) {
  modalReturnFocus.value = fromEl ?? null;
  editingId.value = null;
  modalOpen.value = true;
}

function openEdit(note: NoteMeta, fromEl?: HTMLElement) {
  modalReturnFocus.value = fromEl ?? null;
  editingId.value = note.id;
  modalOpen.value = true;
}

function onModalClosed() {
  modalOpen.value = false;
  editingId.value = null;
  void nextTick(() => {
    const el = modalReturnFocus.value;
    modalReturnFocus.value = null;
    el?.focus?.();
  });
}

const sheetStyle = computed(() => {
  const b = bounds.value;
  if (!b) return { display: 'none' };
  return {
    top: `${b.bottom - heightPx.value}px`,
    left: `${b.left}px`,
    width: `${b.width}px`,
    height: `${heightPx.value}px`,
  };
});

watch(heightPx, (h) => emit('sheet-height', h));

onMounted(async () => {
  ensureOverlayLayer();
  overlayReady.value = true;
  await nextTick();
  measureBounds();
  const columnH = bounds.value?.height ?? window.innerHeight;
  heightPx.value = defaultHeight(columnH);
  emit('sheet-height', heightPx.value);
  resizeObserver = new ResizeObserver(() => measureBounds());
  const el = anchorEl();
  if (el) resizeObserver.observe(el);
  window.addEventListener('resize', measureBounds, { passive: true });
  window.addEventListener('scroll', measureBounds, { passive: true, capture: true });
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  window.removeEventListener('resize', measureBounds);
  window.removeEventListener('scroll', measureBounds, true);
  emit('sheet-height', 0);
});

defineExpose({ measureBounds });
</script>

<template>
  <Teleport v-if="overlayReady" :to="APP_OVERLAY_LAYER">
    <div
      ref="sheetRoot"
      class="story-notes-sheet"
      data-test="story-notes-sheet"
      role="region"
      aria-label="Story notes"
      :style="sheetStyle"
      @keydown="onSheetKeydown"
    >
      <div
        ref="separator"
        class="story-notes-sheet__handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize story notes"
        tabindex="0"
        data-test="story-notes-sheet-resize"
        @pointerdown="onSeparatorPointerDown"
        @keydown="onSeparatorKeydown"
      />
      <StoryNotesPanel
        id="story-notes-panel"
        class="story-notes-sheet__panel"
        :notes-doc="notesDoc"
        :outline="outline"
        :human-author="humanAuthor"
        :readonly="readonly"
        data-test="story-notes-panel"
        @close="requestClose"
        @select-section="emit('select-section', $event)"
        @create="openCreate($event)"
        @edit="openEdit($event.note, $event.from)"
      />
    </div>
    <NoteEditModal
      v-if="modalOpen"
      :notes-doc="notesDoc"
      :outline="outline"
      :human-author="humanAuthor"
      :note-id="editingId"
      :readonly="readonly"
      @close="onModalClosed"
      @saved="onModalClosed"
      @deleted="onModalClosed"
    />
  </Teleport>
</template>

<style scoped>
.story-notes-sheet {
  position: fixed;
  z-index: var(--ct-z-sheet);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--ct-surface-raised);
  border-top: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-lg) var(--ct-radius-lg) 0 0;
  box-shadow: var(--ct-elevation-2);
  animation: story-notes-sheet-in 160ms ease-out;
  font-family: var(--ct-font-ui);
}
@media (prefers-reduced-motion: reduce) {
  .story-notes-sheet {
    animation: none;
  }
}
@keyframes story-notes-sheet-in {
  from {
    transform: translateY(12px);
    opacity: 0.92;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}
.story-notes-sheet__handle {
  flex: none;
  height: 6px;
  cursor: ns-resize;
  border-radius: var(--ct-radius-full);
  margin: var(--ct-space-1) var(--ct-space-4) 0;
  background: var(--ct-border);
}
.story-notes-sheet__handle:focus-visible {
  outline: 2px solid var(--ct-focus-ring-color);
  outline-offset: 2px;
}
.story-notes-sheet__panel {
  flex: 1;
  min-height: 0;
}
</style>
