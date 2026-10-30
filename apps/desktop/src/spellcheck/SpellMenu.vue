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

onMounted(() => void nextTick(() => root.value?.focus()));

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    emit('close');
  }
}

const kindLabel = props.issue.kind === 'spelling' ? 'Spelling' : 'Grammar';
</script>

<template>
  <div
    ref="root"
    class="spell-menu"
    role="menu"
    tabindex="-1"
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
      class="spell-menu__item"
      :data-test="i === 0 ? 'spell-suggest-primary' : undefined"
      @click="emit('suggest', s)"
    >
      {{ s }}
    </button>
    <button
      type="button"
      role="menuitem"
      class="spell-menu__item"
      data-test="spell-ignore"
      @click="emit('ignore')"
    >
      Ignore
    </button>
    <button
      type="button"
      role="menuitem"
      class="spell-menu__item"
      data-test="spell-dictionary"
      @click="emit('dictionary')"
    >
      Add to dictionary
    </button>
  </div>
</template>

<style scoped>
.spell-menu {
  position: fixed;
  z-index: 6;
  min-width: 220px;
  max-width: 320px;
  padding: var(--ct-space-2) 0;
  border: 1px solid var(--ct-border-strong);
  border-radius: var(--ct-radius-md);
  background: var(--ct-surface-raised);
  box-shadow: var(--ct-elevation-2);
  font-family: var(--ct-font-ui);
  font-size: var(--ct-text-sm);
  color: var(--ct-text);
}
.spell-menu:focus {
  outline: 0;
}
.spell-menu__head {
  margin: 0;
  padding: var(--ct-space-2) var(--ct-space-4) var(--ct-space-3);
  border-bottom: 1px solid var(--ct-border);
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
}
.spell-menu__item {
  display: block;
  width: 100%;
  min-height: var(--ct-space-12);
  padding: 0 var(--ct-space-4);
  border: 0;
  background: none;
  color: var(--ct-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.spell-menu__item:hover {
  background: var(--ct-hover-bg);
}
.spell-menu__item:focus-visible {
  outline: 0;
  box-shadow: inset var(--ct-focus-ring);
}
</style>
