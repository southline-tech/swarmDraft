<script setup lang="ts">
/**
 * Collapsed side-panel rail (wp2, #67). Shared by the chapter navigator and review panel so
 * preview and the real app stay aligned.
 */
withDefaults(
  defineProps<{
    side?: 'left' | 'right';
    expandLabel: string;
    /** Optional native tooltip; defaults to expandLabel. */
    expandTitle?: string;
    /** Optional open-count badge (review rail). */
    badge?: number;
    /** Decorative icon character (chapters rail). */
    glyph?: string;
    /** aria-controls target when the panel expands from this rail. */
    controlsId?: string;
    /** Whether the controlled region is expanded (false on a collapsed rail). */
    panelExpanded?: boolean;
  }>(),
  {
    side: 'right',
    expandTitle: undefined,
    badge: undefined,
    glyph: undefined,
    controlsId: undefined,
    panelExpanded: false,
  },
);
defineEmits<{ expand: [] }>();
</script>

<template>
  <aside
    class="panel-rail"
    :class="`panel-rail--${side}`"
    :aria-label="`${expandLabel.replace(/^Show /, '')} (collapsed)`"
    data-test="panel-rail"
  >
    <button
      type="button"
      class="panel-rail__btn"
      :data-test="side === 'left' ? 'outline-rail-expand' : 'expand'"
      :aria-label="expandLabel"
      :title="expandTitle ?? expandLabel"
      :aria-expanded="panelExpanded"
      :aria-controls="controlsId"
      @click="$emit('expand')"
    >
      {{ side === 'left' ? '›' : '‹' }}
    </button>
    <span v-if="glyph" class="panel-rail__glyph" aria-hidden="true">{{ glyph }}</span>
    <span
      v-if="badge !== undefined"
      class="panel-rail__badge"
      data-test="badge"
      :aria-label="`${badge} open changes`"
      >{{ badge }}</span
    >
  </aside>
</template>

<style scoped>
.panel-rail {
  box-sizing: border-box;
  width: var(--ct-rail-w);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--ct-space-3);
  padding: var(--ct-space-2) 0;
  background: var(--ct-surface);
  color: var(--ct-text);
  font-family: var(--ct-font-ui);
  min-height: 0;
  overflow: auto;
}
.panel-rail--left {
  border-right: 1px solid var(--ct-border);
}
.panel-rail--right {
  border-left: 1px solid var(--ct-border);
}
.panel-rail__btn {
  border: 0;
  background: transparent;
  color: var(--ct-text-muted);
  font: inherit;
  cursor: pointer;
  padding: var(--ct-space-1);
  border-radius: var(--ct-radius-sm);
}
.panel-rail__btn:hover,
.panel-rail__btn:focus-visible {
  background: var(--ct-selected-bg);
  outline: none;
  box-shadow: 0 0 0 2px var(--ct-focus-ring-color);
}
.panel-rail__glyph {
  color: var(--ct-text-muted);
  font-size: var(--ct-text-sm);
}
.panel-rail__badge {
  background: var(--ct-accent);
  color: var(--ct-accent-contrast);
  border-radius: var(--ct-radius-full);
  font-size: var(--ct-text-xs);
  padding: 0 var(--ct-space-2);
  min-width: 1.25rem;
  text-align: center;
}
</style>
