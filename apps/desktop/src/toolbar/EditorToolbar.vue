<script setup lang="ts">
/**
 * Single-row formatting toolbar (RAD-254, board WP 1). Groups, in order: navigator toggle |
 * undo, redo | paragraph style | B, I, U | align | comment, overflow | Find | review toggle.
 * Formatting runs through Tiptap commands (./toolbar). Colors come only from --ct-* tokens.
 */
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, toRaw, watch } from 'vue';
import type { Editor } from '@tiptap/core';
import {
  SHORTCUTS,
  STYLE_LABELS,
  SUPPORTED_ALIGN,
  TOOLBAR_STYLES,
  runCommand,
  toolbarState,
  type Align,
  type CaretStyle,
  type ToolbarCommand,
} from './toolbar';

const props = withDefaults(
  defineProps<{
    editor: Editor;
    reviewOpen?: boolean;
    /** Whether the chapter navigator is showing (owned by App.vue). */
    navigatorOpen?: boolean;
    /** Comments and Find land in later issues (RAD-257/259); until wired they show disabled. */
    commentEnabled?: boolean;
    /** Why the editor is read-only (e.g. 'document failed to load', 'restore in progress'). */
    readOnlyReason?: string;
    findEnabled?: boolean;
  }>(),
  {
    reviewOpen: true,
    navigatorOpen: true,
    readOnlyReason: '',
    commentEnabled: false,
    findEnabled: false,
  },
);
const emit = defineEmits<{
  /** The Chapters toggle; App.vue shows or hides the chapter navigator. */
  'toggle-navigator': [];
  'toggle-review': [];
  comment: [];
  find: [];
}>();

/** The live editor, unwrapped from Vue's reactive proxy (Tiptap's view getter throws through it). */
const ed = () => toRaw(props.editor);

// Recompute on every transaction so active states follow the caret.
const tick = ref(0);
const bump = () => tick.value++;
// setEditable() dispatches no transaction (and may skip 'update'), so also watch the DOM's
// contenteditable attribute to follow read-only changes (load error, RAD-237 restore lock).
let observer: MutationObserver | undefined;
function observeEditable(e: Editor) {
  observer?.disconnect();
  let dom: HTMLElement | undefined;
  try {
    dom = e.view.dom;
  } catch {
    return; // not mounted yet; retried on 'create'
  }
  if (typeof MutationObserver === 'undefined') return;
  observer = new MutationObserver(bump);
  observer.observe(dom, { attributes: true, attributeFilter: ['contenteditable'] });
}
function listen(e: Editor | undefined, on: boolean) {
  if (!e) return;
  for (const ev of ['transaction', 'update'] as const) (on ? e.on : e.off).call(e, ev, bump);
}
watch(
  () => ed(),
  (e, old) => {
    listen(old, false);
    listen(e, true);
    observeEditable(e);
    if (!e.isInitialized) e.once('create', () => observeEditable(e));
    bump();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  listen(ed(), false);
  observer?.disconnect();
});
const state = computed(() => (tick.value, toolbarState(ed())));
/** False when the editor is read-only: every formatting control is then disabled. */
const editable = computed(() => state.value.editable);
/** Tooltip and aria-description for formatting controls while read-only. */
const readOnlyText = computed(
  () => `Read-only: ${props.readOnlyReason || 'editing is turned off'}`,
);
/** Formatting control tooltip: the read-only reason replaces the label and shortcut. */
const ftip = (label: string, key?: string) =>
  editable.value ? tip(label, key) : readOnlyText.value;
/** aria-disabled/aria-description pair for a formatting control (focusable while read-only). */
const ro = computed((): Record<string, string> =>
  editable.value ? {} : { 'aria-disabled': 'true', 'aria-description': readOnlyText.value },
);

function run(cmd: ToolbarCommand) {
  if (!ed().isEditable) return bump();
  runCommand(ed(), cmd);
  bump();
}

const styleOptions = computed(() => {
  const s = state.value.style;
  const extra = s && !(TOOLBAR_STYLES as readonly string[]).includes(s) ? [s] : [];
  return [...TOOLBAR_STYLES, ...extra] as Exclude<CaretStyle, ''>[];
});
function onStyle(ev: Event) {
  const el = ev.target as HTMLSelectElement;
  if (!editable.value) {
    el.value = state.value.style; // read-only: keep showing the caret style
    return;
  }
  run(`style:${(ev.target as HTMLSelectElement).value}` as ToolbarCommand);
}

const ALIGNS: { id: Align; label: string; path: string }[] = [
  {
    id: 'left',
    label: 'Align left',
    path: 'M3 4h10M3 7h6M3 10h10M3 13h6',
  },
  {
    id: 'center',
    label: 'Center',
    path: 'M3 4h10M5 7h6M3 10h10M5 13h6',
  },
  {
    id: 'right',
    label: 'Align right',
    path: 'M3 4h10M7 7h6M3 10h10M7 13h6',
  },
  {
    id: 'justify',
    label: 'Justify',
    path: 'M3 4h10M3 7h10M3 10h10M3 13h10',
  },
];

// Overflow menu: the less-common actions.
const menuOpen = ref(false);
const menuEl = shallowRef<HTMLElement | null>(null);
const OVERFLOW: { cmd: ToolbarCommand; label: string; active?: 'smallcaps' | 'strike' }[] = [
  { cmd: 'smallcaps', label: 'Small caps', active: 'smallcaps' },
  { cmd: 'strike', label: 'Strikethrough', active: 'strike' },
  { cmd: 'style:first', label: 'First paragraph' },
  { cmd: 'style:epigraph', label: 'Epigraph' },
  { cmd: 'style:verse', label: 'Verse' },
  { cmd: 'pageBreak', label: 'Insert page break' },
];
const moreBtn = shallowRef<HTMLButtonElement | null>(null);
const wrapEl = shallowRef<HTMLElement | null>(null);
const items = () => [...(menuEl.value?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
function focusItem(i: number) {
  const list = items();
  if (list.length) list[(i + list.length) % list.length]!.focus();
}
function onOutside(ev: PointerEvent) {
  if (!wrapEl.value?.contains(ev.target as Node)) closeMenu(false);
}
function openMenu() {
  menuOpen.value = true;
  document.addEventListener('pointerdown', onOutside, true);
  void nextTick(() => focusItem(0));
}
function closeMenu(refocus = true) {
  if (!menuOpen.value) return;
  menuOpen.value = false;
  document.removeEventListener('pointerdown', onOutside, true);
  if (refocus) moreBtn.value?.focus();
}
function toggleMenu() {
  if (menuOpen.value) closeMenu();
  else openMenu();
}
function onMenuKey(ev: KeyboardEvent) {
  const list = items();
  const i = list.indexOf(document.activeElement as HTMLElement);
  const to: Record<string, number> = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: -1 };
  if (ev.key in to) {
    ev.preventDefault();
    focusItem(to[ev.key]!);
  }
}
onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutside, true));
function pick(cmd: ToolbarCommand) {
  closeMenu();
  run(cmd);
}

const tip = (label: string, key?: string) => (key ? `${label} (${key})` : label);
const SOON = 'coming soon';
const SOON_ATTRS: Record<string, string> = { 'aria-disabled': 'true', 'aria-description': SOON };
const soon = (label: string, key?: string) => `${tip(label, key)} — ${SOON}`;
const btn =
  'inline-flex h-7.5 min-w-7.5 items-center justify-center gap-1.5 rounded-sm border-0 bg-transparent px-1.75 font-ui text-[13px] font-medium text-text cursor-pointer hover:bg-selected disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-pressed:bg-selected aria-pressed:text-accent';
</script>

<template>
  <div
    role="toolbar"
    aria-label="Formatting"
    data-test="editor-toolbar"
    class="flex h-11 items-center gap-0.5 border-b border-border bg-surface px-2.5 font-ui text-text"
  >
    <button
      type="button"
      data-test="tb-navigator"
      :class="btn"
      aria-label="Chapters"
      title="Chapters"
      :aria-pressed="props.navigatorOpen"
      aria-controls="chapter-navigator"
      @click="emit('toggle-navigator')"
    >
      <svg class="tb-i" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
        <path d="M6 3v10" />
      </svg>
    </button>
    <span class="mx-1.5 h-5 w-px bg-border" aria-hidden="true" />

    <button
      type="button"
      data-test="tb-undo"
      :class="btn"
      aria-label="Undo"
      :aria-keyshortcuts="editable && state.hasHistory ? 'Control+Z' : undefined"
      :title="ftip('Undo', state.hasHistory ? SHORTCUTS.undo : undefined)"
      :disabled="editable && !state.canUndo"
      v-bind="ro"
      @click="run('undo')"
    >
      <svg class="tb-i" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M5 6.5H10a3 3 0 0 1 0 6H7" />
        <path d="M7 4 4.5 6.5 7 9" />
      </svg>
    </button>
    <button
      type="button"
      data-test="tb-redo"
      :class="btn"
      aria-label="Redo"
      :aria-keyshortcuts="editable && state.hasHistory ? 'Control+Y' : undefined"
      :title="ftip('Redo', state.hasHistory ? SHORTCUTS.redo : undefined)"
      :disabled="editable && !state.canRedo"
      v-bind="ro"
      @click="run('redo')"
    >
      <svg class="tb-i" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M11 6.5H6a3 3 0 0 0 0 6h3" />
        <path d="M9 4l2.5 2.5L9 9" />
      </svg>
    </button>
    <span class="mx-1.5 h-5 w-px bg-border" aria-hidden="true" />

    <select
      data-test="paragraph-style"
      aria-label="Paragraph style"
      class="h-7.5 w-37 cursor-pointer rounded-sm border border-border bg-surface pr-2 pl-2.5 font-ui text-[13px] font-medium text-text disabled:opacity-40 aria-disabled:cursor-default aria-disabled:opacity-40"
      :value="state.style"
      :disabled="editable && !state.style"
      v-bind="ro"
      :title="editable ? 'Paragraph style' : readOnlyText"
      @mousedown="!editable && $event.preventDefault()"
      @keydown="!editable && !['Tab', 'Escape'].includes($event.key) && $event.preventDefault()"
      @change="onStyle"
    >
      <option v-for="s in styleOptions" :key="s" :value="s">{{ STYLE_LABELS[s] }}</option>
    </select>
    <span class="mx-1.5 h-5 w-px bg-border" aria-hidden="true" />

    <button
      type="button"
      data-test="tb-bold"
      :class="[btn, 'font-manuscript! font-bold']"
      :aria-pressed="state.bold"
      aria-label="Bold"
      :aria-keyshortcuts="editable ? 'Control+B' : undefined"
      :title="ftip('Bold', SHORTCUTS.bold)"
      v-bind="ro"
      @click="run('bold')"
    >
      B
    </button>
    <button
      type="button"
      data-test="tb-italic"
      :class="[btn, 'font-manuscript! italic']"
      :aria-pressed="state.italic"
      aria-label="Italic"
      :aria-keyshortcuts="editable ? 'Control+I' : undefined"
      :title="ftip('Italic', SHORTCUTS.italic)"
      v-bind="ro"
      @click="run('italic')"
    >
      I
    </button>
    <button
      type="button"
      data-test="tb-underline"
      :class="[btn, 'underline']"
      :aria-pressed="state.underline"
      aria-label="Underline"
      :aria-keyshortcuts="editable ? 'Control+U' : undefined"
      :title="ftip('Underline', SHORTCUTS.underline)"
      v-bind="ro"
      @click="run('underline')"
    >
      U
    </button>
    <span class="mx-1.5 h-5 w-px bg-border" aria-hidden="true" />

    <div ref="wrapEl" class="relative" @keydown.esc="closeMenu()">
      <button
        ref="moreBtn"
        type="button"
        data-test="tb-overflow"
        :class="btn"
        aria-label="More formatting"
        aria-haspopup="menu"
        :aria-expanded="menuOpen"
        title="More formatting"
        @click="toggleMenu"
      >
        <svg class="tb-i" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="4" cy="8" r=".6" />
          <circle cx="8" cy="8" r=".6" />
          <circle cx="12" cy="8" r=".6" />
        </svg>
      </button>
      <div
        v-show="menuOpen"
        ref="menuEl"
        role="menu"
        aria-label="More formatting"
        data-test="tb-overflow-menu"
        class="absolute top-9 left-0 z-10 w-64 rounded-md border border-border bg-surface p-1.5 shadow-3"
        @keydown="onMenuKey"
      >
        <!-- Designer pass (#66): alignment, comment, Find and the editor's view actions live here. -->
        <div
          class="mb-1 flex flex-wrap items-center gap-0.5 border-b border-border pb-1"
          role="group"
          aria-label="Paragraph and view"
        >
          <button
            v-for="a in ALIGNS"
            :key="a.id"
            type="button"
            :data-test="`tb-align-${a.id}`"
            :class="btn"
            :aria-pressed="state.align === a.id"
            :aria-label="a.label"
            :title="SUPPORTED_ALIGN.includes(a.id) ? ftip(a.label) : soon(a.label)"
            v-bind="SUPPORTED_ALIGN.includes(a.id) ? ro : SOON_ATTRS"
            @click="SUPPORTED_ALIGN.includes(a.id) && run(`align:${a.id}`)"
          >
            <svg class="tb-i" viewBox="0 0 16 16" aria-hidden="true"><path :d="a.path" /></svg>
          </button>

          <button
            type="button"
            data-test="tb-comment"
            :class="btn"
            aria-label="Add comment"
            :title="props.commentEnabled ? 'Add comment' : soon('Add comment')"
            :aria-disabled="props.commentEnabled ? undefined : 'true'"
            :aria-description="props.commentEnabled ? undefined : SOON"
            @click="props.commentEnabled && emit('comment')"
          >
            <svg class="tb-i" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H7l-3 2.5V11h0A1 1 0 0 1 3 10z"
              />
            </svg>
          </button>
          <button
            type="button"
            data-test="tb-find"
            :class="[btn, 'px-2.5']"
            aria-label="Find"
            :title="props.findEnabled ? 'Find' : soon('Find')"
            :aria-disabled="props.findEnabled ? undefined : 'true'"
            :aria-description="props.findEnabled ? undefined : SOON"
            @click="props.findEnabled && emit('find')"
          >
            <svg class="tb-i" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="7" cy="7" r="3.8" />
              <path d="m10 10 3 3" />
            </svg>
            Find
          </button>
          <slot name="menu" />
        </div>
        <button
          v-for="o in OVERFLOW"
          :key="o.cmd"
          type="button"
          :role="o.active ? 'menuitemcheckbox' : 'menuitem'"
          tabindex="-1"
          v-bind="ro"
          :title="editable ? undefined : readOnlyText"
          :data-test="`tb-menu-${o.cmd.replace(':', '-')}`"
          :aria-checked="o.active ? state[o.active] : undefined"
          class="flex h-7.5 w-full cursor-pointer items-center rounded-sm border-0 bg-transparent px-2.5 text-left font-ui text-[13px] text-text hover:bg-selected hover:text-accent focus:bg-selected aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-text"
          :class="o.active && state[o.active] ? 'bg-selected text-accent' : ''"
          @click="pick(o.cmd)"
        >
          {{ o.label }}
        </button>
      </div>
    </div>

    <span class="flex-1" />
    <slot name="end" />
    <button
      type="button"
      data-test="tb-review"
      :class="btn"
      :aria-pressed="props.reviewOpen"
      aria-label="Review panel"
      :title="'Review panel'"
      @click="emit('toggle-review')"
    >
      <svg class="tb-i" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
        <path d="M10 3v10" />
      </svg>
    </button>
  </div>
</template>

<style>
.tb-i {
  width: 16px;
  height: 16px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
