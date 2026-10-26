<script setup lang="ts">
/**
 * Status-bar zoom (RAD-255, WP1): minus, a 50%-200% slider, plus, and the current percentage.
 * Zoom only changes the view, so it stays enabled when the editor is read-only. Ctrl+= / Ctrl+- /
 * Ctrl+0 are WebView2's own zoom accelerators, so they are not bound or advertised here (RAD-259).
 */
import { ZOOM_MAX, ZOOM_MIN, clampZoom, stepZoom } from './zoom';

const zoom = defineModel<number>({ required: true });
const set = (z: number) => (zoom.value = clampZoom(z));
const btn =
  'inline-flex size-6 items-center justify-center rounded-sm border-0 bg-transparent p-0 text-muted cursor-pointer hover:bg-selected hover:text-text disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent';
const icon = 'size-4 flex-none fill-none stroke-current stroke-[1.6] [stroke-linecap:round]';
</script>

<template>
  <div class="flex items-center gap-1.5" role="group" aria-label="Zoom" data-test="zoom">
    <button
      type="button"
      data-test="zoom-out"
      :class="btn"
      aria-label="Zoom out"
      title="Zoom out"
      :disabled="zoom <= ZOOM_MIN"
      @click="set(stepZoom(zoom, -1))"
    >
      <svg :class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8h8" /></svg>
    </button>
    <input
      type="range"
      data-test="zoom-slider"
      class="h-3 w-21 cursor-pointer accent-accent"
      :min="ZOOM_MIN"
      :max="ZOOM_MAX"
      step="1"
      :value="zoom"
      aria-label="Zoom level"
      :aria-valuetext="`${zoom}%`"
      @input="set(Number(($event.target as HTMLInputElement).value))"
    />
    <button
      type="button"
      data-test="zoom-in"
      :class="btn"
      aria-label="Zoom in"
      title="Zoom in"
      :disabled="zoom >= ZOOM_MAX"
      @click="set(stepZoom(zoom, 1))"
    >
      <svg :class="icon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 3.5v9M3.5 8h9" />
      </svg>
    </button>
    <button
      type="button"
      data-test="zoom-reset"
      class="min-w-10 rounded-sm border-0 bg-transparent px-1 text-right font-ui text-xs font-medium text-text tabular-nums cursor-pointer hover:bg-selected"
      title="Reset zoom to 100%"
      :aria-label="`Zoom ${zoom}%, reset to 100%`"
      @click="set(100)"
    >
      {{ zoom }}%
    </button>
  </div>
</template>
