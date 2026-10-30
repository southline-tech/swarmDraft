<script setup lang="ts">
import PanelRail from './PanelRail.vue';

defineEmits<{ expand: [] }>();
</script>

<template>
  <PanelRail
    id="chapter-navigator-rail"
    side="left"
    expand-label="Show chapters"
    glyph="☰"
    data-test="outline-rail"
    @expand="$emit('expand')"
  />
</template>
