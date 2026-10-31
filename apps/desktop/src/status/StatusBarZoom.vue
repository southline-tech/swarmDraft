<script setup lang="ts">
/**
 * Footer zoom (#204): −, percentage readout (resets to 100%), +. Uses desk/zoom steps and limits.
 * Compact mode (#207 narrow): percentage opens a step menu; ± hidden.
 */
import { ref } from 'vue';
import { ZOOM_MAX, ZOOM_MIN, clampZoom, stepZoom } from '../desk/zoom';

const zoom = defineModel<number>({ required: true });
defineProps<{ compact?: boolean }>();

const menuOpen = ref(false);
const set = (z: number) => {
  zoom.value = clampZoom(z);
  menuOpen.value = false;
};
const btn =
  'inline-flex size-5 items-center justify-center rounded-sm border-0 bg-transparent p-0 font-ui text-xs text-muted cursor-pointer hover:bg-selected hover:text-text aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent';
</script>

<template>
  <div class="flex items-center gap-0.5" role="group" aria-label="Zoom" data-test="status-zoom">
    <template v-if="!compact">
      <button
        type="button"
        data-test="status-zoom-out"
        :class="btn"
        aria-label="Zoom out"
        title="Zoom out"
        :aria-disabled="zoom <= ZOOM_MIN ? 'true' : undefined"
        @click="zoom > ZOOM_MIN && set(stepZoom(zoom, -1))"
      >
        −
      </button>
      <button
        type="button"
        data-test="status-zoom-reset"
        class="min-w-9 rounded-sm border-0 bg-transparent px-0.5 font-ui text-xs text-muted tabular-nums cursor-pointer hover:bg-selected hover:text-text"
        title="Reset zoom to 100%"
        aria-label="Reset zoom, 100%"
        @click="set(100)"
      >
        {{ zoom }}%
      </button>
      <button
        type="button"
        data-test="status-zoom-in"
        :class="btn"
        aria-label="Zoom in"
        title="Zoom in"
        :aria-disabled="zoom >= ZOOM_MAX ? 'true' : undefined"
        @click="zoom < ZOOM_MAX && set(stepZoom(zoom, 1))"
      >
        +
      </button>
    </template>
    <details v-else class="status-zoom-menu" data-test="status-zoom-compact">
      <summary
        class="min-w-9 list-none rounded-sm border-0 bg-transparent px-0.5 font-ui text-xs text-muted tabular-nums cursor-pointer hover:bg-selected hover:text-text"
        data-test="status-zoom-reset"
        aria-haspopup="menu"
        :aria-label="`Zoom ${zoom}%`"
      >
        {{ zoom }}%
      </summary>
      <div class="status-zoom-menu__panel sh-menu" role="menu">
        <button type="button" class="sh-mi" role="menuitem" @click="set(stepZoom(zoom, -1))">
          Zoom out
        </button>
        <button type="button" class="sh-mi" role="menuitem" @click="set(100)">Reset to 100%</button>
        <button type="button" class="sh-mi" role="menuitem" @click="set(stepZoom(zoom, 1))">
          Zoom in
        </button>
      </div>
    </details>
  </div>
</template>

<style scoped>
.status-zoom-menu {
  position: relative;
}
.status-zoom-menu > summary::-webkit-details-marker {
  display: none;
}
.status-zoom-menu__panel {
  position: absolute;
  right: 0;
  bottom: calc(100% + var(--ct-space-1));
  z-index: 30;
  min-width: 10rem;
}
</style>
