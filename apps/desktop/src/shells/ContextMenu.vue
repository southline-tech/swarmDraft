<script setup lang="ts">
/**
 * Editor context menu (wp4, #54). Keyboard: arrows, Enter/Space, Esc (stops propagation).
 */
import { computed, nextTick, onMounted, ref } from 'vue';
import AppIcon from '../icons/AppIcon.vue';
import { MANUSCRIPT_SHORTCUTS, menuShortcutLabel } from './app-shortcuts';
import type { ContextMenuAction } from './context-menu';

const props = defineProps<{
  x: number;
  y: number;
  disabled?: ReadonlySet<ContextMenuAction>;
  /** Current block paragraph style for the style submenu checkmarks. */
  activeStyle?: ContextMenuAction;
  showChapterGroup?: boolean;
  splitTitle?: string;
  mergePrevTitle?: string;
  /** Shown when Copy link to change is disabled (#117). */
  copyLinkTitle?: string;
}>();
const emit = defineEmits<{ close: []; select: [action: ContextMenuAction] }>();
const root = ref<HTMLElement>();
const subOpen = ref(false);

const ITEMS: { id: ContextMenuAction; label: string; keys: string }[] = [
  { id: 'cut', label: 'Cut', keys: 'Ctrl+X' },
  { id: 'copy', label: 'Copy', keys: 'Ctrl+C' },
  { id: 'paste', label: 'Paste', keys: 'Ctrl+V' },
];
const STYLES: { id: ContextMenuAction; label: string; keys: string }[] = [
  { id: 'body', label: 'Body', keys: MANUSCRIPT_SHORTCUTS.body },
  { id: 'heading', label: 'Heading', keys: MANUSCRIPT_SHORTCUTS.heading },
  { id: 'block_quote', label: 'Block quote', keys: MANUSCRIPT_SHORTCUTS.blockQuote },
  { id: 'scene_break', label: 'Scene break', keys: '' },
];
const CHAPTER: { id: ContextMenuAction; label: string; keys: string }[] = [
  { id: 'split_chapter', label: 'Split chapter here', keys: 'Ctrl+Shift+Enter' },
  { id: 'merge_prev_chapter', label: 'Merge with previous chapter', keys: '' },
];
const splitChapterKeys = computed(() => menuShortcutLabel('Ctrl+Shift+Enter'));

function chapterDisabledReason(id: ContextMenuAction): string | undefined {
  if (!isDisabled(id)) return undefined;
  if (id === 'split_chapter') return props.splitTitle;
  if (id === 'merge_prev_chapter') return props.mergePrevTitle;
  return undefined;
}

function chapterReasonId(id: ContextMenuAction) {
  return `ctx-reason-${id}`;
}

function copyLinkReason(): string | undefined {
  if (!isDisabled('copy_link')) return undefined;
  const reason = props.copyLinkTitle?.trim();
  return reason || undefined;
}
const AFTER: { id: ContextMenuAction; label: string; keys: string; icon?: 'sparkle' }[] = [
  { id: 'comment', label: 'Add comment', keys: MANUSCRIPT_SHORTCUTS.comment },
  { id: 'ask-bot', label: 'Ask bot to suggest…', keys: 'Ctrl+Alt+S', icon: 'sparkle' },
];

function isDisabled(id: ContextMenuAction) {
  return props.disabled?.has(id) ?? false;
}

function pick(id: ContextMenuAction) {
  if (isDisabled(id)) return;
  emit('select', id);
  emit('close');
}

function styleTrigger() {
  return root.value?.querySelector<HTMLElement>('[data-test="ctx-style"]') ?? null;
}

function mainMenuItems() {
  return [...(root.value?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])];
}

function styleMenuItems() {
  return [...(root.value?.querySelectorAll<HTMLElement>('[role=menuitemradio]') ?? [])];
}

function openStyleSub(focusFirst = true) {
  subOpen.value = true;
  if (focusFirst) void nextTick(() => styleMenuItems()[0]?.focus());
}

function closeStyleSub(focusTrigger = true) {
  subOpen.value = false;
  if (focusTrigger) void nextTick(() => styleTrigger()?.focus());
}

function onKey(e: KeyboardEvent) {
  const active = document.activeElement as HTMLElement | null;
  const inStyleSub = active?.getAttribute('role') === 'menuitemradio';

  if (e.key === 'ArrowRight') {
    if (active?.dataset.test === 'ctx-style') {
      e.preventDefault();
      openStyleSub();
      return;
    }
  }
  if (e.key === 'ArrowLeft') {
    if (inStyleSub || (subOpen.value && active?.dataset.test === 'ctx-style')) {
      e.preventDefault();
      closeStyleSub();
      return;
    }
  }

  const items = inStyleSub ? styleMenuItems() : mainMenuItems();
  const i = items.indexOf(active as HTMLElement);

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (
      !inStyleSub &&
      active?.dataset.test === 'ctx-style' &&
      subOpen.value &&
      e.key === 'ArrowDown'
    ) {
      openStyleSub();
      return;
    }
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  } else if (e.key === 'Enter' || e.key === ' ') {
    if (active?.dataset.test === 'ctx-style') {
      e.preventDefault();
      if (subOpen.value) closeStyleSub();
      else openStyleSub();
      return;
    }
    const action = active?.dataset.action as ContextMenuAction | undefined;
    if (action && !isDisabled(action)) {
      e.preventDefault();
      pick(action);
    }
  } else if (e.key === 'Escape') {
    if (subOpen.value) {
      e.preventDefault();
      e.stopPropagation();
      closeStyleSub();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    emit('close');
  }
}
onMounted(() => nextTick(() => mainMenuItems()[0]?.focus()));
</script>

<template>
  <div
    ref="root"
    class="sh-menu"
    role="menu"
    aria-label="Editor actions"
    data-test="context-menu"
    :style="{ left: `${x}px`, top: `${y}px` }"
    @keydown="onKey"
    @contextmenu.prevent
  >
    <button
      v-for="it in ITEMS"
      :key="it.id"
      type="button"
      role="menuitem"
      tabindex="-1"
      class="sh-mi"
      :data-test="`ctx-${it.id}`"
      :data-action="it.id"
      :aria-disabled="isDisabled(it.id) ? 'true' : undefined"
      @click="pick(it.id)"
    >
      {{ it.label }}<span class="sh-k">{{ menuShortcutLabel(it.keys) }}</span>
    </button>
    <div class="sh-sep" role="separator" />
    <div style="position: relative" @mouseenter="subOpen = true" @mouseleave="subOpen = false">
      <button
        type="button"
        role="menuitem"
        tabindex="-1"
        aria-haspopup="menu"
        :aria-expanded="subOpen"
        class="sh-mi"
        :class="{ 'sh-open': subOpen }"
        data-test="ctx-style"
        @click="subOpen ? closeStyleSub(false) : openStyleSub()"
        @keydown.right.prevent="openStyleSub()"
      >
        Paragraph style<span class="sh-k">›</span>
      </button>
      <div
        v-if="subOpen"
        class="sh-menu sh-sub"
        role="menu"
        aria-label="Paragraph style"
        style="position: absolute; top: 0"
      >
        <button
          v-for="st in STYLES"
          :key="st.id"
          type="button"
          role="menuitemradio"
          tabindex="-1"
          class="sh-mi"
          :data-test="`ctx-style-${st.id}`"
          :data-action="st.id"
          :aria-checked="activeStyle === st.id ? 'true' : 'false'"
          :aria-disabled="isDisabled(st.id) ? 'true' : undefined"
          @click="pick(st.id)"
        >
          <span class="sh-mi-lead" aria-hidden="true">
            <AppIcon v-if="activeStyle === st.id" name="check" class="sh-mi-check" />
          </span>
          {{ st.label }}<span class="sh-k">{{ menuShortcutLabel(st.keys) }}</span>
        </button>
      </div>
    </div>
    <template v-if="showChapterGroup">
      <div class="sh-sep" role="separator" />
      <p class="ctx-group-label" role="presentation">Chapter</p>
      <button
        v-for="it in CHAPTER"
        :key="it.id"
        type="button"
        role="menuitem"
        tabindex="-1"
        class="sh-mi sh-mi--stack"
        :data-test="`ctx-${it.id}`"
        :data-action="it.id"
        :aria-disabled="isDisabled(it.id) ? 'true' : undefined"
        :aria-describedby="chapterDisabledReason(it.id) ? chapterReasonId(it.id) : undefined"
        @click="pick(it.id)"
      >
        <span class="sh-mi-row">
          {{ it.label
          }}<span v-if="it.id === 'split_chapter' && it.keys" class="sh-k">{{
            splitChapterKeys
          }}</span></span
        >
        <span
          v-if="chapterDisabledReason(it.id)"
          :id="chapterReasonId(it.id)"
          class="sh-mi-reason"
          >{{ chapterDisabledReason(it.id) }}</span
        >
      </button>
    </template>
    <div class="sh-sep" role="separator" />
    <button
      type="button"
      role="menuitem"
      tabindex="-1"
      class="sh-mi sh-mi--stack"
      data-test="ctx-copy_link"
      data-action="copy_link"
      :aria-disabled="isDisabled('copy_link') ? 'true' : undefined"
      :aria-describedby="copyLinkReason() ? 'ctx-reason-copy_link' : undefined"
      @click="pick('copy_link')"
    >
      <span class="sh-mi-row">Copy link to change</span>
      <span v-if="copyLinkReason()" id="ctx-reason-copy_link" class="sh-mi-reason">{{
        copyLinkReason()
      }}</span>
    </button>
    <button
      v-for="it in AFTER"
      :key="it.id"
      type="button"
      role="menuitem"
      tabindex="-1"
      class="sh-mi"
      :data-test="`ctx-${it.id}`"
      :data-action="it.id"
      :aria-disabled="isDisabled(it.id) ? 'true' : undefined"
      @click="pick(it.id)"
    >
      <span class="sh-mi-lead" aria-hidden="true">
        <AppIcon v-if="it.icon" :name="it.icon" class="sh-mi-muted" />
      </span>
      {{ it.label }}<span class="sh-k">{{ menuShortcutLabel(it.keys) }}</span>
    </button>
  </div>
</template>

<style scoped>
.ctx-group-label {
  margin: 0;
  padding: var(--ct-space-1) var(--ct-space-3);
  font-size: var(--ct-text-xs);
  color: var(--ct-text-muted);
}
.sh-mi-lead {
  display: inline-flex;
  width: 16px;
  flex: none;
  align-items: center;
  justify-content: center;
}
.sh-mi-check {
  color: var(--ct-accent);
}
.sh-mi-muted {
  color: var(--ct-text-muted);
}
</style>
