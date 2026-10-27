<script setup lang="ts">
/**
 * Shared 16px line icon set. Same grid and stroke as the editor toolbar icons:
 * 16×16 viewBox, 1.6 stroke, round caps, `currentColor` so the theme tokens drive it.
 * Icons are decorative; the owning control carries the accessible name.
 */
import { ICONS, type IconName } from './icons';

defineProps<{ name: IconName }>();
</script>

<template>
  <svg class="app-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false" :data-icon="name">
    <path v-for="(d, i) in ICONS[name]" :key="i" :d="d" />
  </svg>
</template>

<style scoped>
.app-icon {
  width: 16px;
  height: 16px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
  vertical-align: middle;
}
</style>
