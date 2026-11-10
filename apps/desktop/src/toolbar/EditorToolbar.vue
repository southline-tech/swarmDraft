<script setup lang="ts">
/**
 * Manuscript toolbar (Wave 6a): draft picker | undo/redo | style/B/I | track | review |
 * export | agents | theme | settings. Formatting uses Tiptap (./toolbar). --ct-* tokens only.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, toRaw, watch } from 'vue';
import type { Editor } from '@tiptap/core';
import AppIcon from '../icons/AppIcon.vue';
import DraftPicker, { type DraftPickerRow } from './DraftPicker.vue';
import ToolbarExportMenu from './ToolbarExportMenu.vue';
import ToolbarFlexCluster from './ToolbarFlexCluster.vue';
import OverlayAnchoredMenu from '../overlay/OverlayAnchoredMenu.vue';
import { applyTheme, loadTheme, saveTheme, type Theme } from '../settings/prefs';
import {
  SHORTCUTS,
  STYLE_LABELS,
  TOOLBAR_STYLES,
  runCommand,
  toolbarState,
  type Align,
  type CaretStyle,
  type ToolbarCommand,
} from './toolbar';
import { ariaKeyshortcuts, MANUSCRIPT_SHORTCUTS } from '../shells/app-shortcuts';
import {
  TOOLBAR_OVERFLOW_TEXT_ACTIONS,
  TOOLBAR_SPILL_ORDER,
  pickInlineOverflowItems,
  type ToolbarOverflowItemId,
} from './toolbar-overflow';

const props = withDefaults(
  defineProps<{
    editor: Editor;
    reviewOpen?: boolean;
    /** Whether the chapter navigator is showing (owned by App.vue). */
    navigatorOpen?: boolean;
    navigatorControls?: string;
    /** Comment button stays off until margin comments ship from the toolbar (#52 slice). */
    commentEnabled?: boolean;
    /** Why the editor is read-only (e.g. 'document failed to load', 'restore in progress'). */
    readOnlyReason?: string;
    findEnabled?: boolean;
    /** Active draft label for the picker (issue 243). */
    draftLabel?: string;
    currentDraftId?: string;
    draftRows?: DraftPickerRow[];
    manuscriptId?: string;
    bookTitle?: string;
    tracking?: boolean;
  }>(),
  {
    reviewOpen: true,
    navigatorOpen: true,
    navigatorControls: 'chapter-navigator',
    readOnlyReason: '',
    commentEnabled: false,
    findEnabled: false,
    draftLabel: 'Untitled draft',
    currentDraftId: undefined,
    draftRows: () => [],
    manuscriptId: undefined,
    bookTitle: undefined,
    tracking: false,
  },
);
const emit = defineEmits<{
  /** The Chapters toggle; App.vue shows or hides the chapter navigator. */
  'toggle-navigator': [];
  'toggle-review': [];
  comment: [];
  find: [];
  'toggle-track': [];
  'open-settings': [];
  'open-agents': [];
  'draft-new': [];
  'draft-import': [];
  'draft-select': [id: string];
  'draft-menu-open': [];
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
watch(
  () => ed()?.isEditable,
  () => bump(),
);
let layoutObserver: ResizeObserver | undefined;
onBeforeUnmount(() => {
  listen(ed(), false);
  observer?.disconnect();
  layoutObserver?.disconnect();
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

// Responsive overflow (issue 268): flexible items inline while they fit, else ⋯ only.
const menuOpen = ref(false);
const menuEl = shallowRef<HTMLElement | null>(null);
const toolbarEl = shallowRef<HTMLElement | null>(null);
const leftPinnedEl = shallowRef<HTMLElement | null>(null);
const rightPinnedEl = shallowRef<HTMLElement | null>(null);
const measureEl = shallowRef<HTMLElement | null>(null);
const inlineSet = ref<Set<ToolbarOverflowItemId>>(new Set());
const showInline = (id: ToolbarOverflowItemId) => inlineSet.value.has(id);
const showOverflow = (id: ToolbarOverflowItemId) => !inlineSet.value.has(id);
const hasOverflow = computed(() => TOOLBAR_SPILL_ORDER.some((id) => showOverflow(id)));
const overflowIconGroup = computed(
  () =>
    showOverflow('navigator') ||
    showOverflow('underline') ||
    showOverflow('aligns') ||
    showOverflow('comment') ||
    showOverflow('find'),
);
const overflowTextActions = computed(() =>
  TOOLBAR_OVERFLOW_TEXT_ACTIONS.filter((o) => showOverflow(o.id)),
);

function readWidth(el: Element | null | undefined): number {
  return el?.getBoundingClientRect().width ?? 0;
}

function measureToolbarLayout() {
  const bar = toolbarEl.value;
  const probe = measureEl.value;
  if (!bar || !probe) return;
  const itemWidths: Partial<Record<ToolbarOverflowItemId, number>> = {};
  for (const id of TOOLBAR_SPILL_ORDER) {
    itemWidths[id] = readWidth(probe.querySelector(`[data-tb-measure="${id}"]`));
  }
  const overflowBtnWidth = readWidth(probe.querySelector('[data-tb-measure="overflow-btn"]'));
  const available = readWidth(bar) - readWidth(leftPinnedEl.value) - readWidth(rightPinnedEl.value);
  const { inline } = pickInlineOverflowItems(available, itemWidths, overflowBtnWidth);
  inlineSet.value = new Set(inline);
  if (!hasOverflow.value && menuOpen.value) closeMenu(false);
  if (import.meta.env.DEV) {
    console.debug('[toolbar overflow]', {
      width: readWidth(bar),
      available,
      inline: [...inline],
      overflow: TOOLBAR_SPILL_ORDER.filter((id) => showOverflow(id)),
    });
  }
}

onMounted(() => {
  void nextTick(() => {
    measureToolbarLayout();
    if (typeof ResizeObserver === 'undefined') return;
    layoutObserver = new ResizeObserver(() => measureToolbarLayout());
    if (toolbarEl.value) layoutObserver.observe(toolbarEl.value);
  });
});
watch(
  () => [props.commentEnabled, props.findEnabled, props.navigatorOpen, props.tracking],
  () => void nextTick(measureToolbarLayout),
);

const moreBtn = shallowRef<HTMLButtonElement | null>(null);
const wrapEl = shallowRef<HTMLElement | null>(null);
const items = () => [...(menuEl.value?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
function focusItem(i: number) {
  const list = items();
  if (list.length) list[(i + list.length) % list.length]!.focus();
}
function onOutside(ev: PointerEvent) {
  const t = ev.target as Node;
  if (wrapEl.value?.contains(t)) return;
  if (menuEl.value?.contains(t)) return;
  closeMenu(false);
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
  if (ev.key === 'Escape') {
    ev.preventDefault();
    closeMenu();
    return;
  }
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

const themeMode = ref<Theme>(
  document.documentElement.dataset.theme === 'dark' ? 'dark' : loadTheme(),
);
function toggleTheme() {
  const next: Theme = themeMode.value === 'light' ? 'dark' : 'light';
  themeMode.value = next;
  applyTheme(next);
  saveTheme(next);
}
const themeLabel = computed(() =>
  themeMode.value === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
);
</script>

<template>
  <div class="relative">
    <div
      ref="toolbarEl"
      role="toolbar"
      aria-label="Manuscript"
      data-test="editor-toolbar"
      class="flex h-11 items-center gap-0.5 border-b border-border bg-surface px-2.5 font-ui text-text"
    >
      <div ref="leftPinnedEl" data-test="tb-pinned-left" class="flex shrink-0 items-center gap-0.5">
        <DraftPicker
          :label="props.draftLabel"
          :current-id="props.currentDraftId"
          :drafts="props.draftRows"
          @new-blank="emit('draft-new')"
          @import="emit('draft-import')"
          @select="emit('draft-select', $event)"
          @menu-open="emit('draft-menu-open')"
        />
        <span class="mx-1.5 h-5 w-px bg-border" aria-hidden="true" />

        <button
          type="button"
          data-test="toolbar-undo"
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
          data-test="toolbar-redo"
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
        <span class="mx-1.5 h-5 w-px bg-border" aria-hidden="true" />

        <button
          type="button"
          class="sh-track"
          data-test="track-changes-toggle"
          :aria-pressed="props.tracking"
          :aria-keyshortcuts="ariaKeyshortcuts(MANUSCRIPT_SHORTCUTS.trackChanges)"
          :title="
            (props.tracking ? 'Recording changes on' : 'Recording changes off') +
            ` (${MANUSCRIPT_SHORTCUTS.trackChanges})`
          "
          @click="emit('toggle-track')"
        >
          <svg class="tb-i" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 13l1-3.5L11 2.5l2.5 2.5L6.5 12z" />
          </svg>
          Track changes<template v-if="props.tracking"> · On</template>
        </button>
        <button
          type="button"
          data-test="review-panel-toggle"
          :class="btn"
          :aria-pressed="props.reviewOpen"
          aria-label="Review panel"
          title="Review panel"
          @click="emit('toggle-review')"
        >
          <svg class="tb-i" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
            <path d="M10 3v10" />
          </svg>
          Review
        </button>
      </div>

      <div data-test="tb-inline" class="ml-1 flex shrink-0 flex-wrap items-center gap-0.5">
        <ToolbarFlexCluster
          surface="inline"
          :show="showInline"
          :btn="btn"
          :ro="ro"
          :editable="editable"
          :read-only-text="readOnlyText"
          :state="state"
          :navigator-open="props.navigatorOpen"
          :navigator-controls="props.navigatorControls"
          :comment-enabled="props.commentEnabled"
          :find-enabled="props.findEnabled"
          :text-actions="TOOLBAR_OVERFLOW_TEXT_ACTIONS"
          :aligns="ALIGNS"
          :ftip="ftip"
          :soon="soon"
          :soon-attrs="SOON_ATTRS"
          @toggle-navigator="emit('toggle-navigator')"
          @comment="emit('comment')"
          @find="emit('find')"
          @run="run"
        />
      </div>

      <div
        v-if="hasOverflow"
        ref="wrapEl"
        class="relative ml-1 shrink-0"
        @keydown.esc="closeMenu()"
      >
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
        <OverlayAnchoredMenu :open="menuOpen" :trigger="moreBtn" placement="bottom-start">
          <div
            ref="menuEl"
            role="menu"
            aria-label="More formatting"
            data-test="tb-overflow-menu"
            class="w-64 rounded-md border border-border bg-surface p-1.5 shadow-3"
            @keydown="onMenuKey"
          >
            <div
              v-if="overflowIconGroup"
              class="mb-1 flex flex-wrap items-center gap-0.5 border-b border-border pb-1"
              role="group"
              aria-label="Chapters and formatting"
            >
              <ToolbarFlexCluster
                surface="overflow-icons"
                :show="showOverflow"
                :btn="btn"
                :ro="ro"
                :editable="editable"
                :read-only-text="readOnlyText"
                :state="state"
                :navigator-open="props.navigatorOpen"
                :navigator-controls="props.navigatorControls"
                :comment-enabled="props.commentEnabled"
                :find-enabled="props.findEnabled"
                :text-actions="[]"
                :aligns="ALIGNS"
                :ftip="ftip"
                :soon="soon"
                :soon-attrs="SOON_ATTRS"
                @toggle-navigator="emit('toggle-navigator')"
                @comment="emit('comment')"
                @find="emit('find')"
                @run="run"
              />
              <slot name="menu" />
            </div>
            <ToolbarFlexCluster
              surface="overflow-text"
              :show="showOverflow"
              :btn="btn"
              :ro="ro"
              :editable="editable"
              :read-only-text="readOnlyText"
              :state="state"
              :navigator-open="props.navigatorOpen"
              :navigator-controls="props.navigatorControls"
              :comment-enabled="props.commentEnabled"
              :find-enabled="props.findEnabled"
              :text-actions="overflowTextActions"
              :aligns="ALIGNS"
              :ftip="ftip"
              :soon="soon"
              :soon-attrs="SOON_ATTRS"
              @pick="pick"
            />
          </div>
        </OverlayAnchoredMenu>
      </div>

      <span class="flex-1" aria-hidden="true" />

      <div
        ref="rightPinnedEl"
        data-test="tb-pinned-right"
        class="flex shrink-0 items-center gap-0.5"
      >
        <ToolbarExportMenu :manuscript-id="manuscriptId" :book-title="bookTitle" />
        <button
          type="button"
          :class="btn"
          data-test="toolbar-agents"
          aria-label="Agents"
          title="Agents"
          @click="emit('open-agents')"
        >
          Agents
        </button>
        <button
          type="button"
          :class="btn"
          data-test="toolbar-theme"
          :aria-label="themeLabel"
          :title="themeLabel"
          @click="toggleTheme"
        >
          <AppIcon
            :name="themeMode === 'dark' ? 'sun' : 'moon'"
            class="h-4 w-4"
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          :class="btn"
          data-test="toolbar-settings"
          aria-label="Settings"
          title="Settings"
          @click="emit('open-settings')"
        >
          <AppIcon name="settings" class="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>

    <div
      ref="measureEl"
      aria-hidden="true"
      class="pointer-events-none fixed top-0 left-[-10000px] flex items-center gap-0.5"
    >
      <ToolbarFlexCluster
        surface="measure"
        :show="() => true"
        :btn="btn"
        :ro="ro"
        :editable="editable"
        :read-only-text="readOnlyText"
        :state="state"
        :navigator-open="props.navigatorOpen"
        :navigator-controls="props.navigatorControls"
        :comment-enabled="props.commentEnabled"
        :find-enabled="props.findEnabled"
        :text-actions="TOOLBAR_OVERFLOW_TEXT_ACTIONS"
        :aligns="ALIGNS"
        :ftip="ftip"
        :soon="soon"
        :soon-attrs="SOON_ATTRS"
        @run="run"
      />
      <button type="button" :class="btn" data-tb-measure="overflow-btn" tabindex="-1">
        <svg class="tb-i" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="4" cy="8" r=".6" />
          <circle cx="8" cy="8" r=".6" />
          <circle cx="12" cy="8" r=".6" />
        </svg>
      </button>
    </div>
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
