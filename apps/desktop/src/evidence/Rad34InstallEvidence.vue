<script setup lang="ts">
/** Real-component screenshots for #34 (`?evidence=34-install&frame=…`). */
import { computed, markRaw, nextTick, onMounted, ref } from 'vue';
import HomeScreen from '../HomeScreen.vue';
import ReviewPanel from '../review/ReviewPanel.vue';
import CommentsPanel from '../comments/CommentsPanel.vue';
import StoryNotesPanel from '../notes/StoryNotesPanel.vue';
import StatusBar from '../status/StatusBar.vue';
import SaveFailureBanner from '../errors/SaveFailureBanner.vue';
import ErrorCard from '../shells/ErrorCard.vue';
import { mapError, saveFailed, SAVE_OK } from '../errors/map-error';
import { createNotesDoc } from '../notes/doc';
import { readRad34Frame } from './rad34-evidence';

const frame = readRad34Frame(location.search);
const welcomeHost = ref<HTMLElement | null>(null);

const saveFailure = saveFailed(SAVE_OK, new Error('io: database is locked'));
const noopCopy = async () => ({ status: 'cancelled' as const });

const errors = {
  'error-not-word': mapError(new Error('Not a valid .docx (zip directory not found)'), 'import'),
  'error-file-locked': mapError('io: (os error 32)', 'open'),
  'error-file-damaged': mapError(
    new Error('Part word/document.xml checksum mismatch; file is corrupt'),
    'import',
  ),
  'error-disk-full': mapError('io: There is not enough space on the disk. (os error 112)', 'save'),
  'error-save-failed': mapError('weird failure', 'save'),
} as const;

const errorCard = computed(() => {
  if (frame in errors) return errors[frame as keyof typeof errors];
  return null;
});

const notesDoc = markRaw(createNotesDoc());
const outline = [{ id: 'c1', kind: 'chapter' as const, title: 'Sample Chapter', docId: 'd1' }];

onMounted(async () => {
  await nextTick();
  if (frame === 'c5-welcome') {
    welcomeHost.value?.querySelector<HTMLButtonElement>('[data-test="get-started"]')?.focus();
  }
});
</script>

<template>
  <div class="ev34" data-test="evidence-34" :data-frame="frame">
    <div v-if="frame === 'c5-welcome'" ref="welcomeHost" class="ev34__stage">
      <HomeScreen step="welcome" @get-started="() => {}" />
    </div>
    <div v-else-if="frame === 'c6-open'" class="ev34__stage">
      <HomeScreen step="open" @choose="() => {}" />
    </div>
    <div v-else-if="frame === 'c7-review-empty'" class="ev34__panel">
      <ReviewPanel :items="[]" :list-items="[]" :follow="false" />
    </div>
    <div v-else-if="frame === 'c8-save-failure'" class="ev34__banner">
      <SaveFailureBanner :state="saveFailure" :save-copy="noopCopy" />
    </div>
    <div v-else-if="frame === 'status-saved'" class="ev34__status">
      <StatusBar
        :chapter-count="1"
        :show-chapter-segment="true"
        :word-count="1284"
        :words-before-caret-in-book="0"
        :save="{ phase: 'saved', savedAt: Date.now() }"
        story-notes-panel-id="ev34-notes"
      />
    </div>
    <div v-else-if="errorCard" class="ev34__card">
      <ErrorCard
        :icon="
          frame === 'error-file-locked'
            ? 'lock'
            : frame === 'error-disk-full'
              ? 'disk'
              : frame === 'error-save-failed'
                ? 'save'
                : 'alert'
        "
        :tone="errorCard.tone"
        :title="errorCard.title"
        :text="errorCard.message"
        :action="errorCard.actionLabel"
      />
    </div>
    <div v-else-if="frame === 'empty-comments'" class="ev34__panel">
      <CommentsPanel :threads="[]" />
    </div>
    <div v-else-if="frame === 'empty-notes'" class="ev34__panel">
      <StoryNotesPanel
        :notes-doc="notesDoc"
        :outline="outline"
        :human-author="{ id: 'human:1', name: 'Sample Person' }"
      />
    </div>
  </div>
</template>

<style scoped>
.ev34 {
  box-sizing: border-box;
  min-height: 100vh;
  min-width: 1280px;
  padding: var(--ct-space-4);
  background: var(--ct-bg);
  font-family: var(--ct-font-ui);
  color: var(--ct-text);
}
.ev34__stage {
  min-height: calc(100vh - 2 * var(--ct-space-4));
  display: flex;
}
.ev34__stage :deep(.home) {
  flex: 1;
}
.ev34__panel {
  max-width: 22rem;
  min-height: 28rem;
}
.ev34__banner {
  max-width: 56rem;
  padding-top: var(--ct-space-4);
}
.ev34__status {
  margin-top: auto;
  border-top: 1px solid var(--ct-border);
}
.ev34__card {
  max-width: 28rem;
  padding: var(--ct-space-8);
}
</style>
