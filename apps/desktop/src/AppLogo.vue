<script setup lang="ts">
/**
 * The swarmDraft mark: lowercase c with caret on the accent tile. One asset serves light
 * and dark themes. 48px and up use the SVG master; below that the hinted 24px PNG
 * (48px PNG for 2x screens) keeps the c and caret crisp.
 */
import { computed } from 'vue';
import logo from './assets/logo/coauthor-c-caret.svg';
import logo24 from './assets/logo/coauthor-c-caret-24.png';
import logo48 from './assets/logo/coauthor-c-caret-48.png';

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
