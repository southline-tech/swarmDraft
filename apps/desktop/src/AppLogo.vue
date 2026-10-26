<script setup lang="ts">
/**
 * The coAuthor mark: lowercase c on the accent tile. One asset serves light and dark
 * themes. Below 48px the small-size master (larger glyph) keeps the c legible.
 */
import { computed } from 'vue';
import logo from './assets/logo/coauthor-c-blue.svg';
import logoSmall from './assets/logo/coauthor-c-blue-small.svg';

const props = withDefaults(defineProps<{ size?: number }>(), { size: 64 });
const src = computed(() => (props.size < 48 ? logoSmall : logo));
</script>

<template>
  <img
    class="app-logo"
    data-test="app-logo"
    :src="src"
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
