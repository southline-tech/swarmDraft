<script setup lang="ts">
import { nextTick, ref } from 'vue';

defineProps<{
  /** 'welcome' on the very first launch (shown once), then 'open'. */
  step: 'welcome' | 'open';
  /** True while a manuscript is being opened; the button is disabled. */
  busy?: boolean;
  /** A manuscript is open behind this screen; offer a way back to it. */
  canCancel?: boolean;
}>();
const emit = defineEmits<{
  (e: 'get-started'): void;
  (e: 'choose'): void;
  (e: 'drop-file', file: File): void;
  (e: 'cancel'): void;
}>();

/** Enter/leave counter: child elements fire their own enter/leave, which made the highlight flicker. */
const depth = ref(0);
const dragging = ref(false);
function onEnter() {
  depth.value++;
  dragging.value = true;
}
function onLeave() {
  depth.value = Math.max(0, depth.value - 1);
  if (depth.value === 0) dragging.value = false;
}
function resetDrag() {
  depth.value = 0;
  dragging.value = false;
}
function onDrop(e: DragEvent) {
  resetDrag();
  const file = e.dataTransfer?.files?.[0];
  if (file) emit('drop-file', file);
}

const openButton = ref<HTMLButtonElement | null>(null);
/** Focus the open button (after Get started, so keyboard users land on the next step). */
async function focusOpen() {
  await nextTick();
  openButton.value?.focus();
}
defineExpose({ focusOpen });
</script>

<template>
  <section class="home" data-test="home">
    <div v-if="step === 'welcome'" class="home__inner" data-test="home-welcome">
      <div class="home__mark" aria-hidden="true">c</div>
      <h1 class="home__title">Welcome to coAuthor</h1>
      <p class="home__lede">
        A calm place to write and revise your book. Your writing assistant can only suggest changes
        — you decide what stays.
      </p>
      <button
        type="button"
        class="home__primary"
        data-test="get-started"
        @click="emit('get-started')"
      >
        Get started
      </button>
      <p class="home__note">
        Your book stays on this computer. coAuthor saves your work as you go.
      </p>
    </div>
    <div v-else class="home__inner" data-test="home-open">
      <h1 class="home__title">Let's open your book</h1>
      <p class="home__lede">
        Choose the Word manuscript you've been working on. We'll make a working copy — your original
        file is never changed.
      </p>
      <button
        ref="openButton"
        type="button"
        class="home__primary home__primary--wide"
        data-test="open-manuscript"
        :disabled="busy"
        @click="emit('choose')"
      >
        <svg class="home__icon home__icon--book" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" />
          <path d="M4 21V5" />
        </svg>
        {{ busy ? 'Opening your book…' : 'Open my Word manuscript' }}
      </button>
      <div
        class="home__drop"
        :class="{ 'home__drop--active': dragging }"
        role="region"
        aria-label="Drop a Word manuscript here to open it"
        data-test="drop-zone"
        @dragenter.prevent="onEnter"
        @dragover.prevent
        @dragleave="onLeave"
        @dragend="resetDrag"
        @drop.prevent="onDrop"
      >
        <svg class="home__icon" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M3 13.5h10" />
        </svg>
        <span>Or drag your manuscript here from a folder</span>
      </div>
      <button
        v-if="canCancel"
        type="button"
        class="home__secondary"
        data-test="open-cancel"
        @click="emit('cancel')"
      >
        Back to my book
      </button>
    </div>
  </section>
</template>

<style scoped>
.home {
  flex: 1;
  display: grid;
  place-items: center;
  padding: var(--ct-space-8);
  background: var(--ct-bg);
  color: var(--ct-text);
  font-family: var(--ct-font-ui);
}
.home__inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  max-width: 37.5rem;
  gap: var(--ct-space-4);
}
.home__mark {
  display: grid;
  place-items: center;
  width: var(--ct-space-16);
  height: var(--ct-space-16);
  border-radius: var(--ct-radius-lg);
  background: var(--ct-accent);
  color: var(--ct-accent-contrast);
  font-family: var(--ct-font-manuscript);
  font-weight: var(--ct-weight-bold);
  font-size: var(--ct-text-2xl);
  margin-bottom: var(--ct-space-2);
}
.home__title {
  margin: 0;
  font-family: var(--ct-font-manuscript);
  font-weight: var(--ct-weight-regular);
  font-size: calc(var(--ct-text-3xl) * 1.2);
  line-height: var(--ct-leading-tight);
}
.home__lede {
  margin: 0 0 var(--ct-space-4);
  color: var(--ct-text-muted);
  font-size: var(--ct-text-lg);
  line-height: var(--ct-leading-ui);
}
.home__note {
  margin: var(--ct-space-2) 0 0;
  color: var(--ct-text-muted);
  font-size: var(--ct-text-md);
}
/* Primary target 64-72px tall, always-visible ring like the mockup. */
.home__primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--ct-space-3);
  min-height: var(--ct-space-16);
  padding: 0 var(--ct-space-8);
  border: 0;
  border-radius: var(--ct-radius-lg);
  background: var(--ct-accent);
  color: var(--ct-accent-contrast);
  font: inherit;
  font-size: var(--ct-text-lg);
  font-weight: var(--ct-weight-semibold);
  box-shadow: var(--ct-elevation-2);
  cursor: pointer;
}
.home__primary--wide {
  min-width: 18rem;
  font-size: var(--ct-text-xl);
}
.home__primary:disabled {
  opacity: 0.7;
  cursor: progress;
}
.home__primary:focus-visible {
  outline: 3px solid var(--ct-focus-ring-color);
  outline-offset: 3px;
}
.home__drop {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--ct-space-3);
  width: min(620px, 100%);
  box-sizing: border-box;
  min-height: var(--ct-space-12);
  margin-top: var(--ct-space-2);
  padding: 28px;
  border: 2px dashed var(--ct-border-strong);
  border-radius: var(--ct-radius-lg);
  color: var(--ct-text-muted);
}
.home__drop > * {
  pointer-events: none;
}
.home__drop--active {
  border-color: var(--ct-accent);
  background: var(--ct-selected-bg);
  color: var(--ct-text);
}
.home__icon {
  width: 1em;
  height: 1em;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.home__icon--book {
  stroke-width: 1.6;
}
.home__secondary {
  min-height: var(--ct-space-12);
  padding: 0 var(--ct-space-6);
  border: 1px solid var(--ct-border-strong);
  border-radius: var(--ct-radius-md);
  background: transparent;
  color: var(--ct-text);
  font: inherit;
  cursor: pointer;
}
</style>
