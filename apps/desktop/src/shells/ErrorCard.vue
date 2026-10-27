<script setup lang="ts">
/** ob9: plain-language error card, and (variant="banner") the save-failure banner. Visual only. */
import ShellIcon from './ShellIcon.vue';
import { useDeferredValue } from '../a11y/deferred';
defineProps<{
  icon: 'alert' | 'lock' | 'disk' | 'save';
  tone: 'danger' | 'warning';
  title: string;
  text: string;
  action: string;
  variant?: 'card' | 'banner';
}>();
const emit = defineEmits<{ action: [] }>();
// The assertive region mounts empty; the card goes into it one frame later (#79).
const ready = useDeferredValue(() => true);
</script>

<template>
  <div role="alert" aria-live="assertive" data-test="error-region">
    <section
      v-if="ready"
      class="ec"
      :class="[`ec--${tone}`, variant === 'banner' ? 'ec--banner' : '']"
      :data-test="variant === 'banner' ? 'save-failure-banner' : 'error-card'"
    >
      <span class="ec__icon"><ShellIcon :name="icon" /></span>
      <div class="ec__body">
        <h3 class="ec__title">{{ title }}</h3>
        <p class="ec__text">{{ text }}</p>
      </div>
      <button type="button" class="sh-btn sh-btn--primary" @click="emit('action')">
        {{ action }}
      </button>
    </section>
  </div>
</template>

<style scoped>
.ec {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--ct-space-3);
  padding: var(--ct-space-5);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-lg);
  background: var(--ct-surface-raised);
  box-shadow: var(--ct-elevation-1);
  color: var(--ct-text);
}
.ec__icon {
  display: grid;
  place-items: center;
  width: var(--ct-space-8);
  height: var(--ct-space-8);
  border-radius: var(--ct-radius-md);
}
.ec--danger .ec__icon {
  background: var(--ct-danger-bg);
  color: var(--ct-danger);
}
.ec--warning .ec__icon {
  background: var(--ct-warning-bg);
  color: var(--ct-warning);
}
.ec__title {
  margin: 0 0 var(--ct-space-1);
  font-size: var(--ct-text-md);
  font-weight: var(--ct-weight-semibold);
}
.ec__text {
  margin: 0;
  color: var(--ct-text-muted);
  font-size: var(--ct-text-sm);
}
.ec--banner {
  flex-direction: row;
  align-items: center;
  border-color: var(--ct-danger);
  background: var(--ct-danger-bg);
  box-shadow: none;
}
.ec--banner .ec__body {
  flex: 1;
}
</style>
