<script setup lang="ts">
/**
 * Keyboard shortcuts sheet (wp7, #57). Reference only: lists the planned Windows shortcuts.
 * Takes focus, closes on Esc or the close button, and the opener gets focus back.
 */
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

const emit = defineEmits<{ close: [] }>();
const closeBtn = ref<HTMLButtonElement>();
const opener = document.activeElement as HTMLElement | null;

const GROUPS: { title: string; rows: [string, string[]][] }[] = [
  {
    title: 'Formatting',
    rows: [
      ['Bold', ['Ctrl', 'B']],
      ['Italic', ['Ctrl', 'I']],
      ['Underline', ['Ctrl', 'U']],
      ['Heading', ['Ctrl', 'Alt', '1']],
      ['Block quote', ['Ctrl', 'Alt', '2']],
      ['Body text', ['Ctrl', 'Alt', '0']],
    ],
  },
  {
    title: 'Editing',
    rows: [
      ['Undo', ['Ctrl', 'Z']],
      ['Redo', ['Ctrl', 'Y']],
      ['Find', ['Ctrl', 'F']],
      ['Replace', ['Ctrl', 'H']],
      ['Save now', ['Ctrl', 'S']],
      ['Add comment', ['Ctrl', 'Alt', 'M']],
    ],
  },
  {
    title: 'Review',
    rows: [
      ['Next change', ['Alt', 'Shift', '→']],
      ['Previous change', ['Alt', 'Shift', '←']],
      ['Accept change', ['Ctrl', 'Shift', 'Enter']],
      ['Reject change', ['Ctrl', 'Shift', '⌫']],
    ],
  },
  {
    title: 'View',
    rows: [
      ['Focus mode', ['Ctrl', 'Shift', 'F']],
      ['Exit focus mode', ['Esc']],
      ['Toggle sidebars', ['Ctrl', '\\']],
      ['Zoom in', ['Ctrl', '=']],
      ['Zoom out', ['Ctrl', '-']],
      ['Reset zoom', ['Ctrl', '0']],
    ],
  },
];
function trap(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    emit('close');
  } else if (e.key === 'Tab') {
    e.preventDefault();
    closeBtn.value?.focus();
  }
}
onMounted(() => nextTick(() => closeBtn.value?.focus()));
onBeforeUnmount(() => opener?.focus?.());
</script>

<template>
  <div class="sh-scrim" data-test="shortcuts-scrim" @click.self="emit('close')">
    <div
      class="sh-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sh-shortcuts-title"
      data-test="shortcuts-sheet"
      @keydown="trap"
    >
      <h2 id="sh-shortcuts-title">
        Keyboard shortcuts
        <button
          ref="closeBtn"
          type="button"
          class="sh-btn sh-icon"
          style="margin-left: auto"
          aria-label="Close keyboard shortcuts"
          data-test="shortcuts-close"
          @click="emit('close')"
        >
          ×
        </button>
      </h2>
      <p class="sh-subt">Windows conventions. Press Ctrl+/ any time to open this sheet.</p>
      <div class="sh-cols">
        <section v-for="g in GROUPS" :key="g.title">
          <h3>{{ g.title }}</h3>
          <div v-for="[name, keys] in g.rows" :key="name" class="sh-sr">
            <span>{{ name }}</span>
            <span
              ><kbd v-for="k in keys" :key="k" class="sh-kbd">{{ k }}</kbd></span
            >
          </div>
        </section>
      </div>
      <p class="sh-foot">Press <kbd class="sh-kbd">Esc</kbd> to close</p>
    </div>
  </div>
</template>
