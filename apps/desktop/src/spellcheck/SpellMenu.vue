<script setup lang="ts">
/** Context menu for a spelling or grammar flag (#159 sc2/sc3). */
import type { SpellIssue } from '@coauthor/editor';
import { nextTick, onMounted, ref } from 'vue';

const props = defineProps<{
  x: number;
  y: number;
  issue: SpellIssue;
}>();
const emit = defineEmits<{
  close: [];
  suggest: [text: string];
  ignore: [];
  dictionary: [];
}>();

const root = ref<HTMLElement>();

function menuItems() {
  return [...(root.value?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])];
}

function onKey(e: KeyboardEvent) {
  const active = document.activeElement as HTMLElement | null;
  const items = menuItems();
  const i = items.indexOf(active as HTMLElement);

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? Math.min(i + 1, items.length - 1) : Math.max(i - 1, 0);
    items[next]?.focus();
    return;
  }
  if (e.key === 'Enter' && active?.dataset.action === 'suggest') {
    e.preventDefault();
    emit('suggest', active.dataset.suggest ?? '');
    return;
  }
  if (e.key === 'Escape') {
    e.stopPropagation();
    emit('close');
  }
}

onMounted(() => void nextTick(() => menuItems()[0]?.focus()));

const kindLabel = props.issue.kind === 'spelling' ? 'Spelling' : 'Grammar';
</script>

<template>
  <div
    ref="root"
    class="sh-menu spell-menu"
    role="menu"
    aria-label="Spelling and grammar"
    data-test="spell-menu"
    :style="{ left: `${x}px`, top: `${y}px` }"
    @keydown="onKey"
  >
    <p class="spell-menu__head" data-test="spell-menu-kind">
      <span class="spell-menu__kind">{{ kindLabel }}</span>
      <span class="spell-menu__msg">{{ issue.message }}</span>
    </p>
    <button
      v-for="(s, i) in issue.suggestions"
      :key="s"
      type="button"
      role="menuitem"
      tabindex="-1"
      class="sh-mi"
      data-action="suggest"
      :data-suggest="s"
      :data-test="i === 0 ? 'spell-suggest-primary' : undefined"
      @click="emit('suggest', s)"
    >
      {{ s }}<span v-if="i === 0" class="sh-k">Enter</span>
    </button>
    <div class="sh-sep" role="separator" />
    <button
      v-if="issue.kind === 'spelling'"
      type="button"
      role="menuitem"
      tabindex="-1"
      class="sh-mi"
      data-test="spell-dictionary"
      @click="emit('dictionary')"
    >
      Add to dictionary
    </button>
    <button
      type="button"
      role="menuitem"
      tabindex="-1"
      class="sh-mi"
      data-test="spell-ignore"
      @click="emit('ignore')"
    >
      Ignore
    </button>
  </div>
</template>

<style scoped>
.spell-menu {
  min-width: 260px;
  max-width: 320px;
  padding: var(--ct-space-2) 0;
  z-index: 6;
}
.spell-menu__head {
  margin: 0;
  padding: var(--ct-space-2) var(--ct-space-4) var(--ct-space-3);
  border-bottom: 1px solid var(--ct-border);
  font-family: var(--ct-font-ui);
  font-size: var(--ct-text-sm);
  line-height: 1.4;
}
.spell-menu__kind {
  display: block;
  font-weight: var(--ct-weight-semibold);
  color: var(--ct-text-muted);
  font-size: var(--ct-text-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.spell-menu__msg {
  display: block;
  margin-top: var(--ct-space-1);
  color: var(--ct-text);
}
</style>
