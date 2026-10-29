<script setup lang="ts">
/** tc3 (inline card, not a modal): first-time "your changes will show as …" prompt. Visual shell: emits only, stores nothing. */
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

const props = defineProps<{
  name: string;
  colorName: string;
  color: string;
  /** When true, the seeded name came from the OS account (#57). */
  usedComputerName?: boolean;
  returnFocus?: HTMLElement;
}>();
const emit = defineEmits<{ ok: []; change: []; close: [] }>();
const okBtn = ref<HTMLButtonElement>();
const opener = document.activeElement as HTMLElement | null;

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    emit('close');
  }
}
onMounted(() => nextTick(() => okBtn.value?.focus()));
onBeforeUnmount(() => (props.returnFocus ?? opener)?.focus?.());
</script>

<template>
  <section
    class="np"
    role="status"
    aria-labelledby="np-title"
    data-test="name-prompt"
    @keydown="onKey"
  >
    <span class="np__av" :style="{ background: color }" aria-hidden="true">{{
      name.charAt(0)
    }}</span>
    <div class="np__body">
      <h2 id="np-title" class="np__title">
        Your changes will show as <bdi dir="auto">{{ name }}</bdi
        >, in {{ colorName }}
      </h2>
      <p v-if="usedComputerName" class="np__text">
        We used your computer's name. You only see this once — you can change it any time in
        Settings.
      </p>
      <p v-else class="np__text">
        You only see this once — you can change your name and color any time in Settings.
      </p>
      <p class="np__example">
        Example: <ins class="np__ins" :style="{ '--c': color }">and set down</ins>
      </p>
      <div class="np__actions">
        <button
          ref="okBtn"
          type="button"
          class="sh-btn sh-btn--primary"
          data-test="name-prompt-ok"
          @click="emit('ok')"
        >
          Looks good
        </button>
        <button type="button" class="sh-btn" data-test="name-prompt-change" @click="emit('change')">
          Change name or color
        </button>
      </div>
    </div>
    <button
      type="button"
      class="np__close"
      aria-label="Close"
      data-test="name-prompt-close"
      @click="emit('close')"
    >
      ✕
    </button>
  </section>
</template>

<style scoped>
.np {
  position: relative;
  display: flex;
  gap: var(--ct-space-4);
  max-width: 440px;
  padding: var(--ct-space-5);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-lg);
  background: var(--ct-surface-raised);
  box-shadow: var(--ct-elevation-3);
  color: var(--ct-text);
}
.np__av {
  flex: none;
  display: grid;
  place-items: center;
  width: var(--ct-space-8);
  height: var(--ct-space-8);
  border-radius: var(--ct-radius-full);
  color: var(--ct-surface);
  font-weight: var(--ct-weight-semibold);
}
.np__title {
  margin: 0 var(--ct-space-6) var(--ct-space-1) 0;
  font-size: var(--ct-text-lg);
  font-weight: var(--ct-weight-semibold);
}
.np__text,
.np__example {
  margin: 0 0 var(--ct-space-2);
  color: var(--ct-text-muted);
  font-size: var(--ct-text-sm);
}
.np__example {
  color: var(--ct-text);
}
.np__ins {
  font-family: var(--ct-font-manuscript);
  text-decoration-color: var(--c);
  background: color-mix(in srgb, var(--c) 18%, transparent);
}
.np__actions {
  display: flex;
  gap: var(--ct-space-3);
  margin-top: var(--ct-space-3);
}
.np__close {
  position: absolute;
  top: var(--ct-space-3);
  right: var(--ct-space-3);
  border: 0;
  background: none;
  color: var(--ct-text-muted);
  cursor: pointer;
}
</style>
