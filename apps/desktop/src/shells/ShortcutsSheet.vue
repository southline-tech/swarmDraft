<script setup lang="ts">
/**
 * Keyboard shortcuts sheet (wp7, #56). Lists chords from {@link SHORTCUT_SHEET_GROUPS}.
 * macOS shows Command glyphs; other platforms show Control.
 * Takes focus, closes on Esc or the close button, and the opener gets focus back.
 */
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import AppIcon from '../icons/AppIcon.vue';
import {
  displayChord,
  isMacPlatform,
  MANUSCRIPT_SHORTCUTS,
  SHORTCUT_SHEET_GROUPS,
  shortcutParts,
} from './app-shortcuts';
import { shortcutSheet } from '../copy-deck';

const emit = defineEmits<{ close: [] }>();
const closeBtn = ref<HTMLButtonElement>();
const opener = document.activeElement as HTMLElement | null;

const conventionsLead = isMacPlatform()
  ? shortcutSheet.macConventionsLead
  : shortcutSheet.windowsConventionsLead;
const sheetOpener = displayChord(MANUSCRIPT_SHORTCUTS.shortcutsSheet);
const GROUPS = SHORTCUT_SHEET_GROUPS.map((g) => ({
  title: g.title,
  rows: g.rows.map((r) => [r.label, shortcutParts(r.chord)] as [string, string[]]),
}));
function trap(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    emit('close');
  } else if (e.key === 'Tab') {
    e.preventDefault();
    closeBtn.value?.focus();
  } else {
    e.stopPropagation();
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
      <div class="sh-row sh-sheet__head">
        <h2 id="sh-shortcuts-title">{{ shortcutSheet.sheetTitle }}</h2>
        <button
          ref="closeBtn"
          type="button"
          class="sh-tbtn sh-icon"
          style="margin-left: auto"
          :aria-label="shortcutSheet.closeAriaLabel"
          data-test="shortcuts-close"
          @click="emit('close')"
        >
          <AppIcon name="x" />
        </button>
      </div>
      <p class="sh-subt">
        {{ conventionsLead }}<kbd class="sh-kbd">{{ sheetOpener }}</kbd
        >{{ shortcutSheet.windowsConventionsTrail }}
      </p>
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
      <p class="sh-foot">
        {{ shortcutSheet.escClosePrefix }}<kbd class="sh-kbd">{{ shortcutSheet.escKeyLabel }}</kbd
        >{{ shortcutSheet.escCloseSuffix }}
      </p>
    </div>
  </div>
</template>
