<script setup lang="ts">
/**
 * Preview gallery for the UI shells (Part of #36). Everything here is synthetic sample data and
 * stubbed behavior: no manuscript, Yjs doc, storage or IPC is touched.
 */
import { ref } from 'vue';
import './shells.css';
import { SCREENS, type ScreenId } from './preview';
import NamePrompt from './NamePrompt.vue';
import SettingsScreen from './SettingsScreen.vue';
import OpeningProgress from './OpeningProgress.vue';
import AppToast from './AppToast.vue';
import EmptyState from './EmptyState.vue';
import ErrorCard from './ErrorCard.vue';
import ReasonLine from './ReasonLine.vue';
import { swatchVar } from './colors';
import { PRODUCT_NAME } from '../lib/brand';
import PreviewWorkspace from './PreviewWorkspace.vue';
import type * as Y from 'yjs';

const props = defineProps<{
  initial?: ScreenId | 'all';
  /** Optional live doc; shells must never write to it (tests pass one to prove that). */
  doc?: Y.Doc;
}>();
const emit = defineEmits<{ close: [] }>();
const current = ref<ScreenId | 'all'>(props.initial ?? 'all');
const toastOpen = ref(true);
const promptOpen = ref(true);
const stubNote = ref('');
const show = (id: ScreenId) => current.value === 'all' || current.value === id;
const stub = (what: string) => (stubNote.value = `${what}: preview only, nothing was changed.`);
const theme = ref(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme.value;
}

const errors = [
  {
    icon: 'alert',
    tone: 'danger',
    title: "This isn't a Word manuscript",
    text: `${PRODUCT_NAME} can open books saved from Word. Try choosing a different file.`,
    action: 'Choose another file',
  },
  {
    icon: 'lock',
    tone: 'warning',
    title: 'This book is open in another program',
    text: 'Close it in the other program, then try again.',
    action: 'Try again',
  },
  {
    icon: 'alert',
    tone: 'danger',
    title: "We couldn't read this file",
    text: 'It may be damaged. If you have another copy, try opening that one.',
    action: 'Choose another file',
  },
  {
    icon: 'disk',
    tone: 'warning',
    title: 'Your computer is almost full',
    text: "There isn't enough room to save your book. Free up some space, then try again.",
    action: 'Try again',
  },
  {
    icon: 'save',
    tone: 'danger',
    title: "Your latest changes aren't saved yet",
    text: `Don't close ${PRODUCT_NAME}. We'll keep trying — or save a copy somewhere else now.`,
    action: 'Save a copy',
  },
] as const;
const cards = [
  {
    who: 'Sample Person',
    bot: false,
    color: 2,
    del: 'and wrote down',
    ins: 'and set down',
    reason: '',
  },
  {
    who: 'Sample Bot',
    bot: true,
    color: 1,
    del: 'forty-one',
    ins: 'forty',
    reason: 'Matches the date in Chapter 3.',
  },
  {
    who: 'Sample Bot',
    bot: true,
    color: 1,
    del: 'the fog had come in early',
    ins: 'fog had rolled in before supper',
    reason:
      'Tightens the line and keeps the weather consistent with the harbor scene two pages earlier, where the fog is already described as arriving at supper.',
  },
];
</script>

<template>
  <div class="sp" data-test="shells-preview">
    <header class="sp__bar">
      <b>Screen previews</b>
      <span class="sp__muted">Sample data · buttons do nothing</span>
      <select v-model="current" class="sp__select" aria-label="Screen" data-test="preview-select">
        <option value="all">All screens</option>
        <option v-for="s in SCREENS" :key="s.id" :value="s.id">{{ s.label }}</option>
      </select>
      <button type="button" class="sh-btn" data-test="preview-theme" @click="toggleTheme">
        {{ theme === 'dark' ? 'Light' : 'Dark' }} theme
      </button>
      <button type="button" class="sh-btn" data-test="preview-close" @click="emit('close')">
        Close
      </button>
    </header>
    <p v-if="stubNote" class="sp__note" role="status" data-test="stub-note">{{ stubNote }}</p>

    <section v-if="show('wp1')" class="sp__sec" data-screen="wp1">
      <h2 class="sp__h">wp1 · Editor with review (wp6 = dark)</h2>
      <PreviewWorkspace mode="wp1" @stub="stub" />
    </section>

    <section v-if="show('wp2')" class="sp__sec" data-screen="wp2">
      <h2 class="sp__h">wp2 · Sidebars collapsed</h2>
      <PreviewWorkspace mode="wp2" @stub="stub" />
    </section>
    <section v-if="show('wp8')" class="sp__sec" data-screen="wp8">
      <h2 class="sp__h">wp8 · Review step-through</h2>
      <PreviewWorkspace mode="wp8" @stub="stub" />
    </section>
    <section v-if="show('tc4')" class="sp__sec" data-screen="tc4">
      <h2 class="sp__h">tc4 · Review changes by author (tc6 = dark)</h2>
      <PreviewWorkspace mode="tc4" @stub="stub" />
    </section>

    <section v-if="show('tc3')" class="sp__sec" data-screen="tc3">
      <h2 class="sp__h">tc3 · First-time name &amp; color</h2>
      <NamePrompt
        v-if="promptOpen"
        name="Sample Author"
        color-name="green"
        :color="swatchVar(3)"
        @ok="promptOpen = false"
        @close="promptOpen = false"
        @change="current = 'tc5'"
      />
      <button v-else type="button" class="sh-btn" @click="promptOpen = true">
        Show prompt again
      </button>
    </section>

    <section v-if="show('tc5')" class="sp__sec sp__sec--tall" data-screen="tc5">
      <h2 class="sp__h">tc5 · Settings</h2>
      <SettingsScreen @save="stub('Save')" @close="stub('Cancel')" />
    </section>

    <section v-if="show('ob6')" class="sp__sec" data-screen="ob6">
      <h2 class="sp__h">ob6 · Opening your book</h2>
      <OpeningProgress title="The Lantern Keeper" :found="7" :progress="0.45" />
    </section>

    <section v-if="show('ob7')" class="sp__sec" data-screen="ob7">
      <h2 class="sp__h">ob7 · Toast</h2>
      <AppToast
        v-if="toastOpen"
        lead="Your book is open."
        message="All 7 chapters are here, and your original file is untouched."
        @dismiss="toastOpen = false"
      />
      <button v-else type="button" class="sh-btn" data-test="toast-show" @click="toastOpen = true">
        Show toast
      </button>
    </section>

    <section v-if="show('ob8')" class="sp__sec" data-screen="ob8">
      <h2 class="sp__h">ob8 · Empty states</h2>
      <div class="sp__grid">
        <div>
          <div class="sp__lbl">No book open</div>
          <EmptyState
            icon="book"
            title="No book open yet"
            text="Open your Word manuscript to start writing."
            action="Open my Word manuscript"
            @action="stub('Open')"
          />
        </div>
        <div>
          <div class="sp__lbl">Review panel · nothing to review</div>
          <EmptyState
            icon="sparkle"
            tone="success"
            title="Nothing to review"
            text="When your writing assistant suggests a change, it will show up here for you to keep or skip."
          />
        </div>
        <div>
          <div class="sp__lbl">No comments</div>
          <EmptyState
            icon="comment"
            title="No comments yet"
            text="Select some text and choose Comment to leave yourself a note."
          />
        </div>
      </div>
    </section>

    <section v-if="show('ob9')" class="sp__sec" data-screen="ob9">
      <h2 class="sp__h">ob9 · Errors in plain language</h2>
      <ErrorCard
        variant="banner"
        icon="save"
        tone="danger"
        title="Your latest changes aren't saved yet"
        :text="`Don't close ${PRODUCT_NAME}. We'll keep trying — or save a copy somewhere else now.`"
        action="Save a copy"
        @action="stub('Save a copy')"
      />
      <div class="sp__grid sp__grid--gap">
        <ErrorCard v-for="e in errors" :key="e.title" v-bind="e" @action="stub(e.action)" />
      </div>
    </section>

    <section v-if="show('reason')" class="sp__sec" data-screen="reason">
      <h2 class="sp__h">#60 · Reason line on bot cards</h2>
      <div class="sp__cards">
        <article
          v-for="(c, i) in cards"
          :key="i"
          class="sp__card"
          :style="{ borderLeftColor: swatchVar(c.color) }"
        >
          <div class="sp__who">
            <span class="sp__av" :style="{ background: swatchVar(c.color) }">{{
              c.who.charAt(0)
            }}</span>
            <bdi dir="auto">{{ c.who }}</bdi
            ><span class="sp__kind">{{ c.bot ? 'Bot' : 'Person' }}</span>
          </div>
          <p class="sp__change">
            <del>{{ c.del }}</del> <ins>{{ c.ins }}</ins>
          </p>
          <ReasonLine v-if="c.bot && c.reason" :reason="c.reason" />
          <div class="sp__actions">
            <button type="button" class="sh-btn sh-btn--primary" @click="stub('Accept')">
              Accept
            </button>
            <button type="button" class="sh-btn" @click="stub('Reject')">Reject</button>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>

<style scoped>
.sp {
  min-height: 100%;
  padding-bottom: var(--ct-space-10);
  background: var(--ct-bg);
  color: var(--ct-text);
  font-family: var(--ct-font-ui);
}
.sp__bar {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: var(--ct-space-3);
  padding: var(--ct-space-2) var(--ct-space-4);
  border-bottom: 1px solid var(--ct-border);
  background: var(--ct-surface);
}
.sp__muted {
  flex: 1;
  color: var(--ct-text-muted);
  font-size: var(--ct-text-sm);
}
.sp__select {
  min-height: var(--ct-space-10);
  border: 1px solid var(--ct-border-strong);
  border-radius: var(--ct-radius-md);
  background: var(--ct-surface);
  color: var(--ct-text);
  font: inherit;
}
.sp__note {
  margin: var(--ct-space-3) var(--ct-space-8) 0;
  color: var(--ct-text-muted);
  font-size: var(--ct-text-sm);
}
.sp__sec {
  padding: var(--ct-space-6) var(--ct-space-8);
}
.sp__sec--tall {
  height: 640px;
  display: flex;
  flex-direction: column;
}
.sp__sec--tall > :last-child {
  flex: 1;
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-lg);
  overflow: hidden;
}
.sp__h {
  margin: 0 0 var(--ct-space-4);
  color: var(--ct-text-muted);
  font-size: var(--ct-text-xs);
  font-weight: var(--ct-weight-semibold);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.sp__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--ct-space-6);
}
.sp__grid--gap {
  margin-top: var(--ct-space-6);
}
.sp__lbl {
  margin-bottom: var(--ct-space-2);
  color: var(--ct-text-muted);
  font-size: var(--ct-text-xs);
  font-weight: var(--ct-weight-medium);
  text-transform: uppercase;
}
.sp__cards {
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-3);
  max-width: 280px;
}
.sp__card {
  padding: var(--ct-space-3);
  border: 1px solid var(--ct-border);
  border-left: 3px solid;
  border-radius: var(--ct-radius-md);
  background: var(--ct-surface-raised);
}
.sp__who {
  display: flex;
  align-items: center;
  gap: var(--ct-space-2);
  font-size: var(--ct-text-sm);
  font-weight: var(--ct-weight-medium);
}
.sp__av {
  display: grid;
  place-items: center;
  width: var(--ct-space-5);
  height: var(--ct-space-5);
  border-radius: var(--ct-radius-full);
  color: var(--ct-surface);
  font-size: var(--ct-text-xs);
}
.sp__kind {
  padding: 0 var(--ct-space-2);
  border: 1px solid var(--ct-border-strong);
  border-radius: var(--ct-radius-full);
  color: var(--ct-text-muted);
  font-size: var(--ct-text-xs);
  text-transform: uppercase;
}
.sp__change {
  margin: var(--ct-space-2) 0 0;
  font-family: var(--ct-font-manuscript);
}
.sp__change del {
  background: var(--ct-suggest-delete-bg);
  color: var(--ct-suggest-delete-text);
}
.sp__change ins {
  background: var(--ct-suggest-insert-bg);
}
.sp__actions {
  display: flex;
  gap: var(--ct-space-2);
  margin-top: var(--ct-space-2);
}
</style>
