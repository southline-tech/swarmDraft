<script setup lang="ts">
/** #60: the bot's one-line reason on a review card; long reasons clamp with More/Less. */
import { ref } from 'vue';
const props = defineProps<{ reason: string; limit?: number }>();
const open = ref(false);
const long = () => props.reason.length > (props.limit ?? 90);
</script>

<template>
  <p class="rl" data-test="reason-line">
    <bdi dir="auto" :class="{ rl__clamp: long() && !open }">{{ reason }}</bdi>
    <button
      v-if="long()"
      type="button"
      class="rl__more"
      :aria-expanded="open"
      data-test="reason-more"
      @click="open = !open"
    >
      {{ open ? 'Less' : 'More' }}
    </button>
  </p>
</template>

<style scoped>
.rl {
  margin: var(--ct-space-1) 0 var(--ct-space-2);
  color: var(--ct-text-muted);
  font-size: var(--ct-text-xs);
}
.rl__clamp {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 1;
  line-clamp: 1;
  overflow: hidden;
}
.rl__more {
  padding: 0;
  border: 0;
  background: none;
  color: var(--ct-accent);
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}
</style>
