<script setup lang="ts">
/**
 * Settings (#99): one full-window screen with a section nav. Every section stays mounted (v-show)
 * so backup status, the restore banner and a shown agent key survive switching sections, just
 * like the single panel this replaces.
 */
import { DEFAULT_TRIM, TRIM_SIZES, type NumberingStyle } from '@coauthor/schema';
import { NUMBERING_STYLE_LABELS, NUMBERING_STYLES } from '../numbering-style-labels';
import { nextTick, onMounted, ref } from 'vue';
import AgentsSettings from '../AgentsSettings.vue';
import type { AppInfo } from '../backend';
import iconUrl from '../assets/logo/swarmdraft-icon-small.svg';
import { PRODUCT_NAME } from '../lib/brand';
import BackupsSection from './BackupsSection.vue';
import NameColorSection from './NameColorSection.vue';
import { trapTab } from './focus-trap';
import { applyTheme, loadTheme, saveTheme, type Theme } from './prefs';
import { previewsEnabled } from './previews';
import './settings.css';

defineProps<{
  info: AppInfo | null;
  backupStatus: string;
  confirmingRestore: boolean;
  tokensNotice: number | null;
  bookOpen?: boolean;
  numberingStyle?: NumberingStyle;
}>();
const emit = defineEmits<{
  close: [];
  openPreviews: [];
  backup: [];
  askRestore: [];
  confirmRestore: [];
  cancelRestore: [];
  dismissNotice: [];
  numberingStyle: [style: NumberingStyle];
}>();

const SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'name', label: 'Your name & color' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'backups', label: 'Backups' },
  { id: 'agents', label: 'Agents' },
] as const;
type SectionId = (typeof SECTIONS)[number]['id'];
const section = ref<SectionId>('general');
const root = ref<HTMLElement | null>(null);
const showPreviews = previewsEnabled();
const trim = TRIM_SIZES[DEFAULT_TRIM];
const defaultTrim = `${trim.widthIn} × ${trim.heightIn} in`;

const theme = ref<Theme>(document.documentElement.dataset.theme === 'dark' ? 'dark' : loadTheme());
function setTheme(t: Theme) {
  theme.value = t;
  applyTheme(t);
  saveTheme(t);
}
/** Arrow keys move the selection inside the Light/Dark radiogroup. */
function themeKey(e: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault();
  setTheme(theme.value === 'light' ? 'dark' : 'light');
  void nextTick(() =>
    root.value?.querySelector<HTMLElement>(`[data-test="theme-${theme.value}"]`)?.focus(),
  );
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close');
  else if (root.value) trapTab(e, root.value);
}

onMounted(() => root.value?.focus());
</script>

<template>
  <div
    ref="root"
    class="st"
    role="dialog"
    aria-modal="true"
    aria-label="Settings"
    tabindex="-1"
    data-test="settings"
    @keydown="onKeydown"
  >
    <div class="st__title">
      <img :src="iconUrl" width="18" height="18" alt="" data-test="settings-logo" />
      <b>{{ PRODUCT_NAME }}</b>
    </div>
    <div class="st__main">
      <nav class="st__nav" aria-label="Settings sections" data-test="settings-nav">
        <div class="st__lbl">Settings</div>
        <button
          v-for="s in SECTIONS"
          :key="s.id"
          type="button"
          class="st__navi"
          :class="{ 'st__navi--a': s.id === section }"
          :aria-current="s.id === section ? 'page' : undefined"
          :data-test="`settings-nav-${s.id}`"
          @click="section = s.id"
        >
          {{ s.label }}
        </button>
      </nav>
      <div class="st__pane">
        <div class="st__col">
          <div v-show="section === 'general'" data-test="settings-general">
            <h1 class="st-h1">General</h1>
            <p class="st-muted st-sub">Basic details about this copy of {{ PRODUCT_NAME }}.</p>
            <section
              v-if="bookOpen && numberingStyle"
              class="st-card"
              aria-labelledby="st-numbering"
              data-test="numbering-style"
            >
              <h2 id="st-numbering" class="st-h2">Chapter &amp; part numbers</h2>
              <p class="st-muted st-desc">
                One style for the whole book. Numbers update when you reorder sections; they are not
                stored in the text.
              </p>
              <label class="st-row" for="numbering-style-select">
                <span class="st-row__k">Display style</span>
                <select
                  id="numbering-style-select"
                  class="st-inp"
                  data-test="numbering-style-select"
                  :value="numberingStyle"
                  @change="
                    emit(
                      'numberingStyle',
                      ($event.target as HTMLSelectElement).value as NumberingStyle,
                    )
                  "
                >
                  <option v-for="s in NUMBERING_STYLES" :key="s" :value="s">
                    {{ NUMBERING_STYLE_LABELS[s] }}
                  </option>
                </select>
              </label>
            </section>
            <section class="st-card" aria-labelledby="st-newbooks">
              <h2 id="st-newbooks" class="st-h2">New books</h2>
              <div class="st-row">
                <span class="st-row__k">Default page size</span>
                <b data-test="default-trim">{{ defaultTrim }}</b>
                <span class="st-muted st-small"
                  >Used for every new book. You can't change this yet.</span
                >
              </div>
            </section>
            <section v-if="info" class="st-card" aria-labelledby="st-about" data-test="app-info">
              <h2 id="st-about" class="st-h2">About</h2>
              <div class="st-row">
                <span class="st-row__k">Version</span>
                <span class="st-row__v">{{ info.version }}</span>
              </div>
              <div class="st-row">
                <span class="st-row__k">Your files are kept in</span>
                <span class="st-row__v st-mono">{{ info.dataDir }}</span>
              </div>
              <div class="st-row">
                <span class="st-row__k">Database version</span>
                <span class="st-row__v">{{ info.schemaVersion }}</span>
              </div>
            </section>
            <section v-if="showPreviews" class="st-card st__previews" aria-labelledby="st-previews">
              <div class="st__grow">
                <h2 id="st-previews" class="st-h2">
                  Preview new screens <span class="st-tag">Test builds only</span>
                </h2>
                <p class="st-muted st-desc st-flush">
                  See designs we're still working on. Nothing here changes your books.
                </p>
              </div>
              <button
                type="button"
                class="st-btn st-btn--s"
                data-test="open-previews"
                @click="emit('openPreviews')"
              >
                Open previews
              </button>
            </section>
            <div v-if="!info" class="st-ban st-ban--w st__browser" data-test="browser-mode">
              <div>
                <b>Running in browser mode (no desktop backend).</b> Saving, backups and agents need
                the desktop app.
              </div>
            </div>
          </div>
          <div v-show="section === 'name'">
            <NameColorSection @close="emit('close')" />
          </div>
          <div v-show="section === 'appearance'" data-test="settings-appearance">
            <h1 class="st-h1">Appearance</h1>
            <section class="st-card" aria-labelledby="st-theme">
              <h2 id="st-theme" class="st-h2">Theme</h2>
              <p class="st-muted st-desc">Changes the look of the whole app.</p>
              <div class="st__seg" role="radiogroup" aria-label="Theme" @keydown="themeKey">
                <button
                  v-for="t in ['light', 'dark'] as const"
                  :key="t"
                  type="button"
                  role="radio"
                  class="st__segb"
                  :class="{ 'st__segb--on': theme === t }"
                  :aria-checked="theme === t"
                  :tabindex="theme === t ? 0 : -1"
                  :data-test="`theme-${t}`"
                  @click="setTheme(t)"
                >
                  <svg
                    v-if="theme === t"
                    viewBox="0 0 16 16"
                    width="16"
                    height="16"
                    aria-hidden="true"
                  >
                    <path d="m3.5 8.5 3 3 6-7" />
                  </svg>
                  {{ t === 'light' ? 'Light' : 'Dark' }}
                </button>
              </div>
            </section>
          </div>
          <div v-show="section === 'backups'" data-test="settings-backups">
            <BackupsSection
              v-if="info"
              :status="backupStatus"
              :confirming="confirmingRestore"
              :tokens-notice="tokensNotice"
              @backup="emit('backup')"
              @ask="emit('askRestore')"
              @confirm="emit('confirmRestore')"
              @cancel="emit('cancelRestore')"
              @dismiss="emit('dismissNotice')"
            />
            <template v-else>
              <h1 class="st-h1">Backups</h1>
              <div class="st-ban st-ban--w st__browser">
                <div>
                  <b>Running in browser mode (no desktop backend).</b> Saving, backups and agents
                  need the desktop app.
                </div>
              </div>
            </template>
          </div>
          <div v-show="section === 'agents'" data-test="settings-agents">
            <AgentsSettings v-if="info" />
            <template v-else>
              <h1 class="st-h1">Agents</h1>
              <div class="st-ban st-ban--w st__browser">
                <div>
                  <b>Running in browser mode (no desktop backend).</b> Saving, backups and agents
                  need the desktop app.
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
    <button
      type="button"
      class="st-btn st__close"
      data-test="settings-close"
      @click="emit('close')"
    >
      Close
    </button>
  </div>
</template>

<style scoped>
.st {
  position: fixed;
  inset: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  background: var(--ct-bg);
  color: var(--ct-text);
  font-family: var(--ct-font-ui);
}
.st:focus {
  outline: 0;
}
.st__title {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--ct-space-2);
  height: var(--ct-space-10);
  padding: 0 var(--ct-space-4);
  border-bottom: 1px solid var(--ct-border);
  background: var(--ct-surface);
  color: var(--ct-text-muted);
  font-size: var(--ct-text-sm);
}
.st__title b {
  color: var(--ct-text);
  font-weight: var(--ct-weight-semibold);
}
.st__main {
  display: flex;
  flex: 1;
  min-height: 0;
}
.st__nav {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: var(--ct-space-1);
  width: 240px;
  padding: var(--ct-space-4) var(--ct-space-2);
  border-right: 1px solid var(--ct-border);
  background: var(--ct-surface);
  overflow-y: auto;
}
.st__lbl {
  padding: 0 var(--ct-space-3) var(--ct-space-3);
  color: var(--ct-text-muted);
  font-size: var(--ct-text-xs);
  font-weight: var(--ct-weight-semibold);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.st__navi {
  min-height: var(--ct-space-12);
  padding: 0 var(--ct-space-3);
  border: 0;
  border-radius: var(--ct-radius-md);
  background: none;
  color: var(--ct-text);
  font: inherit;
  font-size: var(--ct-text-sm);
  text-align: left;
  cursor: pointer;
}
.st__navi:hover {
  background: var(--ct-selected-bg);
}
.st__navi:focus-visible {
  outline: 0;
  box-shadow: var(--ct-focus-ring);
}
.st__navi--a {
  background: var(--ct-selected-bg);
  color: var(--ct-accent);
  font-weight: var(--ct-weight-semibold);
}
.st__pane {
  flex: 1;
  min-width: 0;
  padding: var(--ct-space-8) var(--ct-space-16) var(--ct-space-12);
  overflow-y: auto;
}
.st__col {
  max-width: 720px;
}
.st__close {
  position: absolute;
  top: calc(var(--ct-space-10) + var(--ct-space-5));
  right: var(--ct-space-6);
}
.st__previews {
  display: flex;
  align-items: center;
  gap: var(--ct-space-4);
}
.st__grow {
  flex: 1;
}
.st-flush {
  margin-bottom: 0;
}
.st-small {
  font-size: var(--ct-text-sm);
}
.st__browser {
  margin-top: var(--ct-space-5);
}
.st__seg {
  display: inline-flex;
  gap: var(--ct-space-1);
  padding: var(--ct-space-1);
  border: 1px solid var(--ct-border-strong);
  border-radius: var(--ct-radius-md);
  background: var(--ct-bg);
}
.st__segb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--ct-space-2);
  min-width: 120px;
  min-height: var(--ct-space-12);
  padding: 0 var(--ct-space-5);
  border: 0;
  border-radius: var(--ct-radius-md);
  background: none;
  color: var(--ct-text-muted);
  font: inherit;
  font-weight: var(--ct-weight-semibold);
  cursor: pointer;
}
.st__segb:focus-visible {
  outline: 0;
  box-shadow: var(--ct-focus-ring);
}
.st__segb--on {
  background: var(--ct-accent);
  color: var(--ct-accent-contrast);
}
.st__segb svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 2.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
@media (max-width: 1100px) {
  /* Narrow: start the column below the absolutely placed Close button. */
  .st__pane {
    padding-top: calc(var(--ct-space-16) + var(--ct-space-6));
    padding-right: var(--ct-space-10);
    padding-left: var(--ct-space-10);
  }
}
</style>
