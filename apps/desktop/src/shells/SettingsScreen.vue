<script setup lang="ts">
/** tc5: Settings → Your name & color. Visual shell: edits stay local; Save only emits. */
import { ref } from 'vue';
import { SWATCHES, swatchVar } from './colors';

const props = withDefaults(
  defineProps<{ defaultName?: string; defaultColor?: number; taken?: Record<number, string> }>(),
  {
    defaultName: 'Sample Author',
    defaultColor: 3,
    taken: () => ({ 1: 'Sample Assistant', 2: 'Sample Editor' }),
  },
);
const emit = defineEmits<{ close: []; save: [{ name: string; color: number }] }>();
const pages = ['General', 'Your name & color', 'Appearance', 'Backups'] as const;
const page = ref<(typeof pages)[number]>('Your name & color');
const name = ref(props.defaultName);
const color = ref(props.defaultColor);
function reset() {
  name.value = props.defaultName;
  color.value = props.defaultColor;
}
</script>

<template>
  <div class="ss" data-test="settings-screen">
    <nav class="ss__nav" aria-label="Settings sections">
      <div class="ss__lbl">Settings</div>
      <button
        v-for="p in pages"
        :key="p"
        type="button"
        class="ss__navi"
        :class="{ 'ss__navi--a': p === page }"
        :aria-current="p === page ? 'page' : undefined"
        @click="page = p"
      >
        {{ p }}
      </button>
    </nav>
    <div class="ss__main">
      <div v-if="page === 'Your name & color'" class="ss__inner" data-test="settings-name-color">
        <h1 class="ss__h1">Your name &amp; color</h1>
        <p class="ss__muted">
          Track changes works right away using your computer's name and a default color. Change them
          here if you like. Changing it here updates your future changes; changes you've already
          made keep their old label.
        </p>
        <label class="ss__flab" for="ss-name">Your name</label>
        <div class="ss__field">
          <input id="ss-name" v-model="name" class="ss__input" data-test="settings-name" />
          <span v-if="name === defaultName" class="ss__kind">Default · from this computer</span>
        </div>
        <div id="ss-color" class="ss__flab">Your color</div>
        <div class="ss__sw" role="radiogroup" aria-labelledby="ss-color">
          <button
            v-for="s in SWATCHES"
            :key="s.id"
            type="button"
            role="radio"
            class="ss__s"
            :class="{ 'ss__s--sel': color === s.id, 'ss__s--tk': taken[s.id] }"
            :aria-checked="color === s.id"
            :aria-disabled="taken[s.id] ? 'true' : undefined"
            :style="{ '--c': swatchVar(s.id) }"
            :data-test="`swatch-${s.id}`"
            @click="!taken[s.id] && (color = s.id)"
          >
            <i class="ss__dot">{{
              color === s.id ? '✓' : taken[s.id] ? (taken[s.id] ?? '').charAt(0) : ''
            }}</i>
            <span
              >{{ s.name
              }}<small v-if="taken[s.id]"
                >Used by <bdi dir="auto">{{ taken[s.id] }}</bdi></small
              ><small v-else-if="color === s.id"
                >Your color{{ s.id === defaultColor ? ' · Default' : '' }}</small
              ></span
            >
          </button>
        </div>
        <div class="ss__preview">
          <span class="ss__muted">Preview:</span>
          <ins class="ss__ins" :style="{ '--c': swatchVar(color) }">and set down</ins>
          <span class="ss__chip"
            ><span class="ss__av" :style="{ background: swatchVar(color) }">{{
              name.charAt(0)
            }}</span
            ><bdi dir="auto">{{ name }}</bdi
            ><span class="ss__kind">Person</span></span
          >
        </div>
        <div class="ss__actions">
          <button
            type="button"
            class="sh-btn sh-btn--primary"
            data-test="settings-save"
            @click="emit('save', { name, color })"
          >
            Save
          </button>
          <button type="button" class="sh-btn" data-test="settings-cancel" @click="emit('close')">
            Cancel
          </button>
          <button
            type="button"
            class="sh-btn sh-btn--link"
            data-test="settings-reset"
            @click="reset"
          >
            Reset to default
          </button>
        </div>
      </div>
      <div v-else class="ss__inner">
        <h1 class="ss__h1">{{ page }}</h1>
        <p class="ss__muted">Coming soon. Use the Settings panel in the top bar for now.</p>
        <button type="button" class="sh-btn" @click="emit('close')">Close</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ss {
  display: flex;
  min-height: 100%;
  background: var(--ct-bg);
  color: var(--ct-text);
}
.ss__nav {
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-1);
  width: 170px;
  padding: var(--ct-space-4) var(--ct-space-2);
  border-right: 1px solid var(--ct-border);
  background: var(--ct-surface);
}
.ss__lbl {
  padding: 0 var(--ct-space-3) var(--ct-space-3);
  color: var(--ct-text-muted);
  font-size: var(--ct-text-xs);
  font-weight: var(--ct-weight-semibold);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.ss__navi {
  padding: var(--ct-space-2) var(--ct-space-3);
  border: 0;
  border-radius: var(--ct-radius-md);
  background: none;
  color: var(--ct-text);
  font: inherit;
  font-size: var(--ct-text-sm);
  text-align: left;
  cursor: pointer;
}
.ss__navi--a {
  background: var(--ct-selected-bg);
  color: var(--ct-accent);
  font-weight: var(--ct-weight-medium);
}
.ss__main {
  flex: 1;
  padding: var(--ct-space-10) var(--ct-space-16);
  overflow: auto;
}
.ss__inner {
  max-width: 640px;
}
.ss__h1 {
  margin: 0 0 var(--ct-space-2);
  font-family: var(--ct-font-manuscript);
  font-size: var(--ct-text-xl);
  font-weight: var(--ct-weight-regular);
}
.ss__muted {
  color: var(--ct-text-muted);
}
.ss__flab {
  display: block;
  margin: var(--ct-space-6) 0 var(--ct-space-2);
  font-size: var(--ct-text-sm);
  font-weight: var(--ct-weight-semibold);
}
.ss__field {
  display: flex;
  align-items: center;
  gap: var(--ct-space-3);
  padding: 0 var(--ct-space-3);
  border: 1px solid var(--ct-border-strong);
  border-radius: var(--ct-radius-md);
  background: var(--ct-surface);
}
.ss__input {
  flex: 1;
  min-width: 0;
  min-height: var(--ct-space-10);
  border: 0;
  background: none;
  color: var(--ct-text);
  font: inherit;
}
.ss__kind {
  padding: 0 var(--ct-space-2);
  border: 1px solid var(--ct-border-strong);
  border-radius: var(--ct-radius-full);
  color: var(--ct-text-muted);
  font-size: var(--ct-text-xs);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
}
.ss__sw {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--ct-space-2);
}
.ss__s {
  display: flex;
  align-items: center;
  gap: var(--ct-space-2);
  padding: var(--ct-space-2);
  min-height: var(--ct-space-10);
  border: 1px solid var(--ct-border-strong);
  border-radius: var(--ct-radius-md);
  background: var(--ct-surface);
  color: var(--ct-text);
  font: inherit;
  font-size: var(--ct-text-sm);
  text-align: left;
  cursor: pointer;
}
.ss__s small {
  display: block;
  color: var(--ct-text-muted);
  font-size: var(--ct-text-xs);
}
.ss__s--sel {
  border: 2px solid var(--ct-text);
}
.ss__s--tk {
  border-style: dashed;
  cursor: not-allowed;
  opacity: 0.75;
}
.ss__dot {
  flex: none;
  display: grid;
  place-items: center;
  width: var(--ct-space-6);
  height: var(--ct-space-6);
  border-radius: var(--ct-radius-full);
  background: var(--c);
  color: var(--ct-surface);
  font-style: normal;
  font-size: var(--ct-text-xs);
}
.ss__preview {
  display: flex;
  align-items: center;
  gap: var(--ct-space-3);
  margin-top: var(--ct-space-6);
}
.ss__ins {
  font-family: var(--ct-font-manuscript);
  font-size: var(--ct-text-lg);
  text-decoration-color: var(--c);
  background: color-mix(in srgb, var(--c) 18%, transparent);
}
.ss__chip {
  display: inline-flex;
  align-items: center;
  gap: var(--ct-space-2);
  font-weight: var(--ct-weight-semibold);
  font-size: var(--ct-text-sm);
}
.ss__av {
  display: grid;
  place-items: center;
  width: var(--ct-space-6);
  height: var(--ct-space-6);
  border-radius: var(--ct-radius-full);
  color: var(--ct-surface);
  font-size: var(--ct-text-xs);
}
.ss__actions {
  display: flex;
  gap: var(--ct-space-3);
  margin-top: var(--ct-space-8);
}
</style>
