<script setup lang="ts">
/**
 * swarmDraft mark: 48px+ uses the full SVG (circle accent); below 48px the small-mark
 * 24/48 PNG pair keeps the simplified S crisp on dense screens.
 */
import { computed } from 'vue';
import logo from './assets/logo/swarmdraft-icon.svg';
import logo24 from './assets/logo/swarmdraft-icon-24.png';
import logo48 from './assets/logo/swarmdraft-icon-48.png';

const props = withDefaults(defineProps<{ size?: number }>(), { size: 64 });
const small = computed(() => props.size < 48);
const src = computed(() => (small.value ? logo24 : logo));
const srcset = computed(() => (small.value ? `${logo24} 1x, ${logo48} 2x` : undefined));
</script>

<template>
  <img
    class="app-logo"
    data-test="app-logo"
    :src="src"
    :srcset="srcset"
    :width="size"
    :height="size"
    alt=""
    aria-hidden="true"
    draggable="false"
  />
</template>

<style scoped>
.app-logo {
  display: block;
  flex: none;
}
</style>
