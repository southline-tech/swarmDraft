<script setup lang="ts">
/** ob6: opening / import progress card (#80, #299). Visual only; the caller supplies the numbers. */
import { nextTick, onMounted, ref } from 'vue';
import ShellIcon from './ShellIcon.vue';
import { opening } from '../copy-deck';

const props = defineProps<{
  title: string;
  found: number;
  progress: number;
  kind?: 'open' | 'import';
  indeterminate?: boolean;
  cancellable?: boolean;
}>();

const emit = defineEmits<{ (e: 'cancel'): void }>();

const card = ref<HTMLElement | null>(null);
onMounted(async () => {
  await nextTick();
  card.value?.focus();
});

const verb = () => (props.kind === 'import' ? opening.verbImport : opening.verbOpen);
</script>

<template>
  <section
    ref="card"
    class="op"
    tabindex="-1"
    role="status"
    aria-live="polite"
    :aria-busy="indeterminate ? 'true' : undefined"
    data-test="opening-progress"
    @keydown.esc.prevent="cancellable && emit('cancel')"
  >
    <span class="op__icon"><ShellIcon name="book" /></span>
    <h2 class="op__title">
      {{ verb() }} “<bdi dir="auto">{{ title }}</bdi
      >”…
    </h2>
    <p class="op__text">
      {{ kind === 'import' ? opening.importHint : opening.openHint }}
    </p>
    <div
      class="op__bar"
      :class="{ 'op__bar--indeterminate': indeterminate }"
      :role="indeterminate ? undefined : 'progressbar'"
      :aria-label="indeterminate ? undefined : opening.progressLabel(verb())"
      :aria-valuemin="indeterminate ? undefined : 0"
      :aria-valuemax="indeterminate ? undefined : 100"
      :aria-valuenow="indeterminate ? undefined : Math.round(progress * 100)"
    >
      <span
        v-if="!indeterminate"
        class="op__fill"
        :style="{ width: `${Math.round(progress * 100)}%` }"
      />
    </div>
    <p v-if="found > 0" class="op__count">{{ opening.chaptersFound(found) }}</p>
    <button
      v-if="cancellable"
      type="button"
      class="op__cancel sh-btn sh-btn--secondary"
      data-test="opening-cancel"
      @click="emit('cancel')"
    >
      {{ opening.cancel }}
    </button>
  </section>
</template>

<style scoped>
.op {
  max-width: 560px;
  margin: 0 auto;
  padding: calc(var(--ct-space-10) + var(--ct-space-1));
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-lg);
  background: var(--ct-surface-raised);
  box-shadow: var(--ct-elevation-2);
  color: var(--ct-text);
  text-align: center;
}
.op:focus-visible {
  outline: 2px solid var(--ct-focus-ring-color);
  outline-offset: 2px;
}
.op__icon {
  display: inline-grid;
  place-items: center;
  width: var(--ct-space-12);
  height: var(--ct-space-12);
  border-radius: var(--ct-radius-md);
  background: var(--ct-selected-bg);
  color: var(--ct-accent);
}
.op__title {
  margin: var(--ct-space-4) 0 var(--ct-space-2);
  font-size: var(--ct-text-xl);
  font-weight: var(--ct-weight-semibold);
}
.op__text,
.op__count {
  margin: 0;
  color: var(--ct-text-muted);
  font-size: var(--ct-text-sm);
}
.op__bar {
  height: var(--ct-progress-track-height);
  margin: var(--ct-space-6) 0 var(--ct-space-3);
  border-radius: var(--ct-radius-full);
  background: var(--ct-border);
  overflow: hidden;
}
.op__bar--indeterminate {
  position: relative;
}
.op__bar--indeterminate::after {
  content: '';
  position: absolute;
  inset: 0;
  width: 40%;
  border-radius: inherit;
  background: var(--ct-accent);
  animation: op-slide 1.2s ease-in-out infinite;
}
@keyframes op-slide {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(250%);
  }
}
.op__fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--ct-accent);
}
.op__cancel {
  margin-top: var(--ct-space-4);
}
</style>
