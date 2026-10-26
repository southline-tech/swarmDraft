<script setup lang="ts">
/**
 * Single-row formatting toolbar (RAD-254, board WP 1). Groups, in order: navigator toggle |
 * undo, redo | paragraph style | B, I, U | align | comment, overflow | Find | review toggle.
 * Formatting runs through Tiptap commands (./toolbar). Colors come only from --ct-* tokens.
 */
import { computed, onBeforeUnmount, ref, shallowRef, toRaw, watch } from 'vue';
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
    navigatorOpen?: boolean;
    reviewOpen?: boolean;
    /** Comments and Find land in later issues (RAD-257/259); until wired they show disabled. */
    commentEnabled?: boolean;
    findEnabled?: boolean;
  }>(),
  { navigatorOpen: true, reviewOpen: true, commentEnabled: false, findEnabled: false },
);
const emit = defineEmits<{
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
watch(
  () => ed(),
  (e, old) => {
    old?.off('transaction', bump);
    e.on('transaction', bump);
  },
  { immediate: true },
);
onBeforeUnmount(() => ed().off('transaction', bump));
const state = computed(() => (tick.value, toolbarState(ed())));

function run(cmd: ToolbarCommand) {
  runCommand(ed(), cmd);
  bump();
}

const styleOptions = computed(() => {
  const s = state.value.style;
  const extra = s && !(TOOLBAR_STYLES as readonly string[]).includes(s) ? [s] : [];
  return [...TOOLBAR_STYLES, ...extra] as Exclude<CaretStyle, ''>[];
});
function onStyle(ev: Event) {
  run(`style:${(ev.target as HTMLSelectElement).value}` as ToolbarCommand);
}

const ALIGNS: { id: Align; label: string; key: string; path: string }[] = [
  {
    id: 'left',
    label: 'Align left',
    key: SHORTCUTS.alignLeft,
    path: 'M3 4h10M3 7h6M3 10h10M3 13h6',
  },
  {
    id: 'center',
    label: 'Center',
    key: SHORTCUTS.alignCenter,
    path: 'M3 4h10M5 7h6M3 10h10M5 13h6',
  },
  {
    id: 'right',
    label: 'Align right',
    key: SHORTCUTS.alignRight,
    path: 'M3 4h10M7 7h6M3 10h10M7 13h6',
  },
  {
    id: 'justify',
    label: 'Justify',
    key: SHORTCUTS.alignJustify,
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
function toggleMenu() {
  menuOpen.value = !menuOpen.value;
  if (menuOpen.value)
    requestAnimationFrame(() => menuEl.value?.querySelector<HTMLElement>('button')?.focus());
}
function pick(cmd: ToolbarCommand) {
  menuOpen.value = false;
  run(cmd);
}

const tip = (label: string, key?: string) => (key ? `${label} (${key})` : label);
const btn =
  'inline-flex h-7.5 min-w-7.5 items-center justify-center gap-1.5 rounded-sm border-0 bg-transparent px-1.75 font-ui text-[13px] font-medium text-text cursor-pointer hover:bg-selected disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent aria-pressed:bg-selected aria-pressed:text-accent';
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
      :aria-pressed="props.navigatorOpen"
      aria-label="Chapters"
      :aria-keyshortcuts="'Control+\\'"
      :title="tip('Chapters', SHORTCUTS.navigator)"
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
      aria-keyshortcuts="Control+Z"
      :title="tip('Undo', SHORTCUTS.undo)"
      :disabled="!state.canUndo"
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
      aria-keyshortcuts="Control+Y"
      :title="tip('Redo', SHORTCUTS.redo)"
      :disabled="!state.canRedo"
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
      :title="`Paragraph style (${SHORTCUTS.bodyText}, ${SHORTCUTS.heading}, ${SHORTCUTS.blockQuote})`"
      class="h-7.5 w-37 cursor-pointer rounded-sm border border-border bg-surface pr-2 pl-2.5 font-ui text-[13px] font-medium text-text disabled:opacity-40"
      :value="state.style"
      :disabled="!state.style || !state.editable"
      @change="onStyle"
    >
      <option v-for="s in styleOptions" :key="s" :value="s">{{ STYLE_LABELS[s] }}</option>
    </select>
    <span class="mx-1.5 h-5 w-px bg-border" aria-hidden="true" />

    <button
      type="button"
      data-test="tb-bold"
      :class="[btn, 'font-manuscript font-bold']"
      :aria-pressed="state.bold"
      aria-label="Bold"
      aria-keyshortcuts="Control+B"
      :title="tip('Bold', SHORTCUTS.bold)"
      @click="run('bold')"
    >
      B
    </button>
    <button
      type="button"
      data-test="tb-italic"
      :class="[btn, 'font-manuscript italic']"
      :aria-pressed="state.italic"
      aria-label="Italic"
      aria-keyshortcuts="Control+I"
      :title="tip('Italic', SHORTCUTS.italic)"
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
      aria-keyshortcuts="Control+U"
      :title="tip('Underline', SHORTCUTS.underline)"
      @click="run('underline')"
    >
      U
    </button>
    <span class="mx-1.5 h-5 w-px bg-border" aria-hidden="true" />

    <button
      v-for="a in ALIGNS"
      :key="a.id"
      type="button"
      :data-test="`tb-align-${a.id}`"
      :class="btn"
      :aria-pressed="state.align === a.id"
      :aria-label="a.label"
      :title="
        SUPPORTED_ALIGN.includes(a.id)
          ? tip(a.label, a.key)
          : `${tip(a.label, a.key)}: not available yet`
      "
      :disabled="!SUPPORTED_ALIGN.includes(a.id)"
      @click="run(`align:${a.id}`)"
    >
      <svg class="tb-i" viewBox="0 0 16 16" aria-hidden="true"><path :d="a.path" /></svg>
    </button>
    <span class="mx-1.5 h-5 w-px bg-border" aria-hidden="true" />

    <button
      type="button"
      data-test="tb-comment"
      :class="btn"
      aria-label="Add comment"
      aria-keyshortcuts="Control+Alt+M"
      :title="tip('Add comment', SHORTCUTS.comment)"
      :disabled="!props.commentEnabled"
      @click="emit('comment')"
    >
      <svg class="tb-i" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H7l-3 2.5V11h0A1 1 0 0 1 3 10z"
        />
      </svg>
    </button>
    <div class="relative" @keydown.esc="menuOpen = false">
      <button
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
        v-if="menuOpen"
        ref="menuEl"
        role="menu"
        aria-label="More formatting"
        data-test="tb-overflow-menu"
        class="absolute top-9 left-0 z-10 w-56 rounded-md border border-border bg-surface p-1.5 shadow-3"
      >
        <button
          v-for="o in OVERFLOW"
          :key="o.cmd"
          type="button"
          role="menuitem"
          :data-test="`tb-menu-${o.cmd.replace(':', '-')}`"
          :aria-checked="o.active ? state[o.active] : undefined"
          class="flex h-7.5 w-full cursor-pointer items-center rounded-sm border-0 bg-transparent px-2.5 text-left font-ui text-[13px] text-text hover:bg-selected hover:text-accent"
          :class="o.active && state[o.active] ? 'bg-selected text-accent' : ''"
          @click="pick(o.cmd)"
        >
          {{ o.label }}
        </button>
      </div>
    </div>

    <span class="flex-1" />
    <button
      type="button"
      data-test="tb-find"
      :class="[btn, 'px-2.5']"
      aria-label="Find"
      aria-keyshortcuts="Control+F"
      :title="tip('Find', SHORTCUTS.find)"
      :disabled="!props.findEnabled"
      @click="emit('find')"
    >
      <svg class="tb-i" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="7" cy="7" r="3.8" />
        <path d="m10 10 3 3" />
      </svg>
      Find
    </button>
    <span class="mx-1.5 h-5 w-px bg-border" aria-hidden="true" />
    <button
      type="button"
      data-test="tb-review"
      :class="btn"
      :aria-pressed="props.reviewOpen"
      aria-label="Review panel"
      :title="tip('Review panel', SHORTCUTS.review)"
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
