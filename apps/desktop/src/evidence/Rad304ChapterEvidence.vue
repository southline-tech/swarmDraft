<script setup lang="ts">
import '../shells/shells.css';
import ContextMenu from '../shells/ContextMenu.vue';
import type { ContextMenuAction } from '../shells/context-menu';
import SplitChapterPopover from '../chapter/SplitChapterPopover.vue';
import MergeChapterConfirm from '../chapter/MergeChapterConfirm.vue';
import { readRad304Frame } from './rad304-evidence';

const frame = readRad304Frame(window.location.search);
const menuDisabled = new Set<ContextMenuAction>();
</script>
<template>
  <div class="rad304-evidence" data-test="rad304-evidence">
    <ContextMenu
      v-if="frame === 'context-menu'"
      :x="120"
      :y="80"
      :disabled="menuDisabled"
      show-chapter-group
    />
    <SplitChapterPopover
      v-if="frame === 'split-popover'"
      :x="200"
      :y="120"
      title="Chapter Twelve"
      :remove-line="true"
    />
    <MergeChapterConfirm
      v-if="frame === 'merge-confirm'"
      target-title="Chapter Eleven"
      source-title="Chapter Twelve"
      :skip-ask-session="false"
    />
    <div v-if="frame === 'chapter-toast'" class="chapter-toast" data-test="chapter-action-toast">
      <p class="chapter-toast__msg">
        Split into “Chapter Twelve”
        <span class="chapter-toast__detail">Notes linked to both chapters</span>
      </p>
      <button type="button" class="sh-btn" data-test="chapter-toast-undo">Undo</button>
      <button type="button" class="sh-btn" data-test="chapter-toast-dismiss">Dismiss</button>
    </div>
    <div v-if="frame === 'split-across-pill'" class="pill-scene">
      <span class="pill" data-test="split-across-pill">Split across chapters</span>
    </div>
  </div>
</template>
<style scoped>
.rad304-evidence {
  min-height: 100vh;
  background: var(--ct-surface);
  padding: var(--ct-space-4);
}
.chapter-toast {
  position: fixed;
  bottom: var(--ct-space-12);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ct-space-2);
  padding: var(--ct-space-3) var(--ct-space-4);
  background: var(--ct-surface-raised);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-lg);
}
.chapter-toast__msg {
  margin: 0;
}
.chapter-toast__detail {
  display: block;
  margin-top: var(--ct-space-1);
  color: var(--ct-text-muted);
  font-size: var(--ct-text-sm);
}
.pill-scene {
  padding: var(--ct-space-8);
}
.pill {
  display: inline-block;
  padding: 2px 8px;
  border-radius: var(--ct-radius-sm);
  background: var(--ct-surface-muted);
  font-size: var(--ct-text-xs);
}
</style>
