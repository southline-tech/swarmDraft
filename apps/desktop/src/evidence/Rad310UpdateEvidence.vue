<script setup lang="ts">
/** Update prompt screenshots for #310 (`?evidence=310-updater&frame=…`). */
import { computed } from 'vue';
import UpdatePromptToast from '../updater/UpdatePromptToast.vue';
import { readRad310Frame } from './rad310-evidence';

const frame = readRad310Frame(location.search);

const mode = computed(() => {
  if (frame === 'progress') return 'downloading' as const;
  if (frame === 'up-to-date') return 'manual-message' as const;
  return 'available' as const;
});
</script>

<template>
  <div class="ev310" data-test="evidence-310" :data-frame="frame">
    <div class="ev310__stage">
      <UpdatePromptToast
        :mode="mode"
        :version="frame === 'available' || frame === 'progress' ? '0.2.0' : null"
        :progress="frame === 'progress' ? 62 : null"
        :manual-message="frame === 'up-to-date' ? 'up-to-date' : null"
      />
    </div>
  </div>
</template>

<style scoped>
.ev310 {
  box-sizing: border-box;
  min-height: 100vh;
  padding: var(--ct-space-8);
  background: var(--ct-bg);
}
.ev310__stage {
  width: 1280px;
  max-width: 100%;
  margin: 0 auto;
  padding-top: var(--ct-space-12);
}
</style>
