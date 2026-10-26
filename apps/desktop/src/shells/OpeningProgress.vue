<script setup lang="ts">
/** ob6: "Opening <book>…" progress card. Visual only; the caller supplies the numbers. */
import ShellIcon from './ShellIcon.vue';
defineProps<{ title: string; found: number; progress: number }>();
</script>

<template>
  <section class="op" role="status" aria-live="polite" data-test="opening-progress">
    <span class="op__icon"><ShellIcon name="book" /></span>
    <h2 class="op__title">
      Opening “<bdi dir="auto">{{ title }}</bdi
      >”…
    </h2>
    <p class="op__text">Getting your chapters ready. This usually takes a few seconds.</p>
    <div
      class="op__bar"
      role="progressbar"
      aria-label="Opening progress"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="Math.round(progress * 100)"
    >
      <span class="op__fill" :style="{ width: `${Math.round(progress * 100)}%` }" />
    </div>
    <p class="op__count">Found {{ found }} chapters so far</p>
  </section>
</template>

<style scoped>
.op {
  max-width: 396px;
  margin: 0 auto;
  padding: var(--ct-space-8);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-lg);
  background: var(--ct-surface-raised);
  box-shadow: var(--ct-elevation-2);
  color: var(--ct-text);
  text-align: center;
}
.op__icon {
  display: inline-grid;
  place-items: center;
  width: var(--ct-space-8);
  height: var(--ct-space-8);
  border-radius: var(--ct-radius-md);
  background: var(--ct-selected-bg);
  color: var(--ct-accent);
}
.op__title {
  margin: var(--ct-space-4) 0 var(--ct-space-2);
  font-size: var(--ct-text-lg);
  font-weight: var(--ct-weight-semibold);
}
.op__text,
.op__count {
  margin: 0;
  color: var(--ct-text-muted);
  font-size: var(--ct-text-sm);
}
.op__bar {
  height: 6px;
  margin: var(--ct-space-6) 0 var(--ct-space-3);
  border-radius: var(--ct-radius-full);
  background: var(--ct-border);
  overflow: hidden;
}
.op__fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--ct-accent);
}
</style>
