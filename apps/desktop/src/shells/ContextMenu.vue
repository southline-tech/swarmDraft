<script setup lang="ts">
/**
 * Editor context menu (wp4, #54). Keyboard: arrows, Enter/Space, Esc (stops propagation).
 */
import { nextTick, onMounted, ref } from 'vue';
import AppIcon from '../icons/AppIcon.vue';
import type { ContextMenuAction } from './context-menu';

const props = defineProps<{
  x: number;
  y: number;
  disabled?: ReadonlySet<ContextMenuAction>;
  /** Current block paragraph style for the style submenu checkmarks. */
  activeStyle?: ContextMenuAction;
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
  { id: 'body', label: 'Body', keys: 'Ctrl+Alt+0' },
  { id: 'heading', label: 'Heading', keys: 'Ctrl+Alt+1' },
  { id: 'block_quote', label: 'Block quote', keys: 'Ctrl+Alt+2' },
  { id: 'scene_break', label: 'Scene break', keys: '' },
];
const AFTER: { id: ContextMenuAction; label: string; keys: string; icon?: 'sparkle' }[] = [
  { id: 'comment', label: 'Add comment', keys: 'Ctrl+Alt+M' },
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

function onKey(e: KeyboardEvent) {
  const items = [...(root.value?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])];
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  } else if (e.key === 'Enter' || e.key === ' ') {
    const el = document.activeElement as HTMLElement | null;
    if (el?.dataset.test === 'ctx-style') {
      e.preventDefault();
      subOpen.value = !subOpen.value;
      return;
    }
    const action = el?.dataset.action as ContextMenuAction | undefined;
    if (action && !isDisabled(action)) {
      e.preventDefault();
      pick(action);
    }
  } else if (e.key === 'Escape') {
    // Escape closes only the menu; don't let it reach the editor's focus-mode exit.
    e.preventDefault();
    e.stopPropagation();
    emit('close');
  }
}
onMounted(() => nextTick(() => root.value?.querySelector<HTMLElement>('[role=menuitem]')?.focus()));
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
      {{ it.label }}<span class="sh-k">{{ it.keys }}</span>
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
        @click="subOpen = !subOpen"
        @keydown.right.prevent="subOpen = true"
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
          {{ st.label }}<span class="sh-k">{{ st.keys }}</span>
        </button>
      </div>
    </div>
    <div class="sh-sep" role="separator" />
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
      {{ it.label }}<span class="sh-k">{{ it.keys }}</span>
    </button>
  </div>
</template>

<style scoped>
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
