<script setup lang="ts">
/** Small stroke icons used by the shells (book, sparkle, comment, alert, lock, disk, save, check). */
defineProps<{
  name: 'book' | 'sparkle' | 'comment' | 'alert' | 'lock' | 'disk' | 'save' | 'check';
}>();
</script>

<template>
  <svg class="ic" viewBox="0 0 16 16" aria-hidden="true">
    <path
      v-if="name === 'book'"
      d="M3 2.5h8.5v11H4.5A1.5 1.5 0 0 1 3 12V2.5Zm0 9.5a1.5 1.5 0 0 1 1.5-1.5h7"
    />
    <path
      v-else-if="name === 'sparkle'"
      d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M12 4l-2 2M6 10l-2 2"
    />
    <path v-else-if="name === 'comment'" d="M2.5 3h11v7.5H6L3 13v-2.5h-.5V3Z" />
    <path v-else-if="name === 'alert'" d="M8 2.5 14 13H2L8 2.5ZM8 6.5v3M8 11.2v.1" />
    <path v-else-if="name === 'lock'" d="M4 7h8v6.5H4V7Zm1.5 0V5a2.5 2.5 0 0 1 5 0v2" />
    <path v-else-if="name === 'disk'" d="M2 4.5h12v7H2v-7ZM4.5 9h7" />
    <path v-else-if="name === 'save'" d="M3 2.5h8l2 2v9H3v-11Zm2 0v3.5h5V2.5M5 13.5v-4h6v4" />
    <path v-else d="m3.5 8.5 3 3 6-7" />
  </svg>
</template>

<style scoped>
.ic {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
