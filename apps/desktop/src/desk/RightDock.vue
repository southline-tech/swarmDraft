<script setup lang="ts">
import PanelRail from './PanelRail.vue';
import { displayChord } from '../shells/app-shortcuts';
import type { RightDockTab } from '../history/history-dock-state';
import '../shells/shells.css';

withDefaults(
  defineProps<{
    open: boolean;
    tab: RightDockTab;
    reviewBadge?: number;
    collapsed?: boolean;
    controlsId?: string;
  }>(),
  {
    reviewBadge: 0,
    collapsed: false,
    controlsId: 'right-dock-panel',
  },
);

const emit = defineEmits<{
  'update:tab': [tab: RightDockTab];
  'toggle-open': [];
}>();

const dockHideLabel = `Hide history panel (${displayChord('Ctrl+\\')})`;
</script>

<template>
  <div
    class="right-dock"
    :class="{ 'right-dock--collapsed': collapsed || !open, 'right-dock--open': open && !collapsed }"
    data-test="right-dock"
  >
    <PanelRail
      v-if="!open || collapsed"
      side="right"
      :expand-label="tab === 'history' ? 'Show History' : 'Show Review'"
      :badge="reviewBadge || undefined"
      :controls-id="controlsId"
      :panel-expanded="open && !collapsed"
      @expand="emit('toggle-open')"
    />
    <div
      v-show="open && !collapsed"
      :id="controlsId"
      class="right-dock__body"
      data-test="right-dock-body"
    >
      <div class="right-dock__tabs" role="tablist" aria-label="Review and History">
        <button
          type="button"
          class="right-dock__tab"
          role="tab"
          data-test="dock-tab-review"
          :aria-selected="tab === 'review'"
          :tabindex="tab === 'review' ? 0 : -1"
          @click="emit('update:tab', 'review')"
        >
          Review
          <span
            v-if="reviewBadge > 0"
            class="right-dock__badge"
            :aria-label="`${reviewBadge} changes waiting for review`"
            >{{ reviewBadge }}</span
          >
        </button>
        <button
          type="button"
          class="right-dock__tab"
          role="tab"
          data-test="dock-tab-history"
          :aria-selected="tab === 'history'"
          :tabindex="tab === 'history' ? 0 : -1"
          @click="emit('update:tab', 'history')"
        >
          History
        </button>
      </div>
      <div class="right-dock__panel" role="tabpanel">
        <div v-show="tab === 'review'" class="right-dock__slot" data-test="dock-panel-review">
          <slot name="review" />
        </div>
        <div v-show="tab === 'history'" class="right-dock__slot" data-test="dock-panel-history">
          <slot name="history" />
        </div>
      </div>
      <button
        type="button"
        class="right-dock__hide sh-btn sh-btn--ghost sh-btn--sm"
        data-test="dock-hide"
        :aria-label="dockHideLabel"
        :title="dockHideLabel"
        @click="emit('toggle-open')"
      >
        Hide panel ({{ displayChord('Ctrl+\\') }})
      </button>
    </div>
  </div>
</template>
