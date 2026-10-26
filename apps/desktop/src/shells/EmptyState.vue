<script setup lang="ts">
/** ob8: icon-card empty state. */
import ShellIcon from './ShellIcon.vue';
defineProps<{
  icon: 'book' | 'sparkle' | 'comment';
  title: string;
  text: string;
  action?: string;
  tone?: 'accent' | 'success';
}>();
const emit = defineEmits<{ action: [] }>();
</script>

<template>
  <section class="es" data-test="empty-state">
    <span class="es__icon" :class="tone === 'success' ? 'es__icon--ok' : ''"
      ><ShellIcon :name="icon"
    /></span>
    <h3 class="es__title">{{ title }}</h3>
    <p class="es__text">{{ text }}</p>
    <button v-if="action" type="button" class="sh-btn" @click="emit('action')">{{ action }}</button>
  </section>
</template>

<style scoped>
.es {
  padding: var(--ct-space-6) var(--ct-space-8) var(--ct-space-6);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-lg);
  background: var(--ct-surface-raised);
  box-shadow: var(--ct-elevation-1);
  color: var(--ct-text);
  text-align: center;
}
.es__icon {
  display: inline-grid;
  place-items: center;
  width: var(--ct-space-8);
  height: var(--ct-space-8);
  border-radius: var(--ct-radius-md);
  background: var(--ct-selected-bg);
  color: var(--ct-accent);
}
.es__icon--ok {
  background: var(--ct-success-bg);
  color: var(--ct-success);
}
.es__title {
  margin: var(--ct-space-4) 0 var(--ct-space-2);
  font-size: var(--ct-text-md);
  font-weight: var(--ct-weight-semibold);
}
.es__text {
  margin: 0 0 var(--ct-space-4);
  color: var(--ct-text-muted);
  font-size: var(--ct-text-sm);
}
</style>
