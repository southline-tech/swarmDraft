<script setup lang="ts">
/**
 * Toolbar Agents window (#245 / #244): operational surface; pairing keys stay in Settings.
 */
import { nextTick, onMounted, ref } from 'vue';
import { trapTab } from '../settings/focus-trap';

defineProps<{
  batchBanner?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  'open-settings': [];
}>();

const root = ref<HTMLElement | null>(null);

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close');
  else if (root.value) trapTab(e, root.value);
}

onMounted(async () => {
  await nextTick();
  root.value?.querySelector<HTMLElement>('[data-test="agents-close"]')?.focus();
});
</script>

<template>
  <div class="aw-scrim" data-test="agents-scrim" @click.self="emit('close')">
    <div
      ref="root"
      class="aw"
      role="dialog"
      aria-modal="true"
      aria-labelledby="aw-title"
      data-test="agents-window"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <header class="aw__head">
        <h2 id="aw-title" class="aw__title">Agents</h2>
        <button
          type="button"
          class="aw__close"
          data-test="agents-close"
          aria-label="Close"
          @click="emit('close')"
        >
          ×
        </button>
      </header>
      <p v-if="batchBanner" class="aw__banner" role="status" data-test="agents-batch-banner">
        Five bots paired. Select them below to grant draft access in bulk.
      </p>
      <div class="aw__body" data-test="agents-list">
        <p class="aw__muted">
          Draft access and bulk actions land in the next wave. Pairing keys and removing agents stay
          in Settings.
        </p>
      </div>
      <footer class="aw__foot">
        <button
          type="button"
          class="aw__link"
          data-test="agents-settings-link"
          @click="emit('open-settings')"
        >
          Open Settings…
        </button>
        <button type="button" class="aw__done" data-test="agents-done" @click="emit('close')">
          Done
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.aw-scrim {
  position: fixed;
  inset: 0;
  z-index: 6;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--ct-space-4);
  background: var(--ct-scrim);
}
.aw {
  display: flex;
  flex-direction: column;
  width: min(32rem, 100%);
  max-height: min(28rem, 100%);
  border-radius: var(--ct-radius-lg);
  border: 1px solid var(--ct-border);
  background: var(--ct-surface);
  color: var(--ct-text);
  font-family: var(--ct-font-ui);
  box-shadow: var(--ct-elevation-3);
}
.aw:focus {
  outline: none;
}
.aw__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ct-space-3);
  padding: var(--ct-space-4);
  border-bottom: 1px solid var(--ct-border);
}
.aw__title {
  margin: 0;
  font-size: var(--ct-text-lg);
  font-weight: var(--ct-weight-semibold);
}
.aw__close {
  min-width: var(--ct-space-8);
  min-height: var(--ct-space-8);
  border: 0;
  border-radius: var(--ct-radius-sm);
  background: transparent;
  color: var(--ct-text-muted);
  font-size: var(--ct-text-xl);
  cursor: pointer;
}
.aw__close:focus-visible {
  outline: 2px solid var(--ct-focus-ring-color);
  outline-offset: 2px;
}
.aw__banner {
  margin: 0;
  padding: var(--ct-space-3) var(--ct-space-4);
  background: var(--ct-success-bg);
  color: var(--ct-text);
  font-size: var(--ct-text-sm);
}
.aw__body {
  flex: 1;
  overflow: auto;
  padding: var(--ct-space-4);
}
.aw__muted {
  margin: 0;
  color: var(--ct-text-muted);
  font-size: var(--ct-text-sm);
  line-height: var(--ct-leading-body);
}
.aw__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--ct-space-3);
  padding: var(--ct-space-3) var(--ct-space-4);
  border-top: 1px solid var(--ct-border);
}
.aw__link {
  border: 0;
  background: none;
  color: var(--ct-accent);
  font-size: var(--ct-text-sm);
  cursor: pointer;
  text-decoration: underline;
}
.aw__done {
  min-height: var(--ct-space-8);
  padding: 0 var(--ct-space-4);
  border: 0;
  border-radius: var(--ct-radius-sm);
  background: var(--ct-accent);
  color: var(--ct-paper);
  font-weight: var(--ct-weight-semibold);
  cursor: pointer;
}
.aw__done:focus-visible {
  outline: 2px solid var(--ct-focus-ring-color);
  outline-offset: 2px;
}
</style>
