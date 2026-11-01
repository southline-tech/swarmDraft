<script setup lang="ts">
/**
 * Toolbar draft picker (#245 placeholder for #243): one active draft until multi-draft ships.
 */
import { shallowRef } from 'vue';
import AppIcon from '../icons/AppIcon.vue';
import { useToolbarMenu } from './menu';

defineProps<{
  label: string;
}>();

const emit = defineEmits<{
  'new-blank': [];
  import: [];
}>();

const trigger = shallowRef<HTMLButtonElement | null>(null);
const menuEl = shallowRef<HTMLElement | null>(null);
const { open, wrapEl, close, toggle, onMenuKey } = useToolbarMenu(menuEl, trigger);

const btn =
  'inline-flex h-7.5 max-w-48 items-center gap-1.5 rounded-sm border-0 bg-transparent px-2 font-ui text-[13px] font-medium text-text cursor-pointer hover:bg-selected focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ct-focus-ring-color)]';
</script>

<template>
  <div ref="wrapEl" class="relative shrink-0" @keydown.esc="close()">
    <button
      ref="trigger"
      type="button"
      :class="btn"
      data-test="draft-picker"
      aria-haspopup="menu"
      :aria-expanded="open"
      :title="`Draft: ${label}`"
      :aria-label="`Draft: ${label}`"
      @click="toggle()"
    >
      <AppIcon name="book" class="h-4 w-4 shrink-0" aria-hidden="true" />
      <span class="truncate">{{ label }}</span>
      <AppIcon name="chevron-down" class="h-4 w-4 shrink-0 opacity-70" aria-hidden="true" />
    </button>
    <div
      v-show="open"
      ref="menuEl"
      role="menu"
      aria-label="Drafts"
      data-test="draft-menu"
      class="absolute top-9 left-0 z-20 min-w-56 rounded-md border border-border bg-surface p-1.5 shadow-3"
      @keydown="onMenuKey"
    >
      <button
        type="button"
        role="menuitem"
        tabindex="-1"
        class="tb-menu-item"
        data-test="draft-new"
        @click="
          () => {
            close();
            emit('new-blank');
          }
        "
      >
        New blank draft
      </button>
      <button
        type="button"
        role="menuitem"
        tabindex="-1"
        class="tb-menu-item"
        data-test="draft-import"
        @click="
          () => {
            close();
            emit('import');
          }
        "
      >
        Import…
      </button>
      <div class="my-1 h-px bg-border" role="separator" />
      <button
        type="button"
        role="menuitemradio"
        tabindex="-1"
        class="tb-menu-item tb-menu-item--on"
        data-test="draft-item"
        :data-draft="label"
        aria-checked="true"
        aria-current="true"
        @click="close()"
      >
        {{ label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.tb-menu-item {
  display: flex;
  width: 100%;
  min-height: var(--ct-space-8);
  align-items: center;
  padding: 0 var(--ct-space-2);
  border: 0;
  border-radius: var(--ct-radius-sm);
  background: transparent;
  color: var(--ct-text);
  font-family: var(--ct-font-ui);
  font-size: var(--ct-text-sm);
  text-align: left;
  cursor: pointer;
}
.tb-menu-item:hover,
.tb-menu-item:focus-visible {
  background: var(--ct-selected-bg);
  color: var(--ct-accent);
  outline: none;
}
.tb-menu-item--on {
  background: var(--ct-selected-bg);
  color: var(--ct-accent);
  font-weight: var(--ct-weight-semibold);
}
</style>
