<script setup lang="ts">
/** Settings → Your name & color (#99). Save keeps the name and color on this computer. */
import { isTauri } from '@tauri-apps/api/core';
import { ref } from 'vue';
import { agentsApi } from '../backend';
import { SWATCHES, swatchVar } from '../shells/colors';
import {
  DEFAULT_PROFILE,
  loadProfile,
  normalizeProfile,
  profileNameSaveError,
  saveProfile,
} from './prefs';

const props = defineProps<{
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  /** Sync display name to SQLite before localStorage (#45); defaults to desktop IPC. */
  syncDisplayName?: (name: string) => Promise<string>;
}>();
const emit = defineEmits<{ close: [] }>();

const store = () => props.storage ?? globalThis.localStorage;
const saved = loadProfile(store());
const name = ref(saved.name);
const color = ref(saved.color);
const status = ref('');

async function save() {
  status.value = '';
  const kept = normalizeProfile({ name: name.value, color: color.value });
  try {
    if (props.syncDisplayName) {
      kept.name = await props.syncDisplayName(kept.name);
    } else if (isTauri()) {
      kept.name = await agentsApi.setUserDisplayName(kept.name);
    }
    saveProfile(kept, store());
    name.value = kept.name;
    color.value = kept.color;
    status.value = 'Saved.';
  } catch (e) {
    console.error('Profile save failed', e);
    status.value = profileNameSaveError(e);
  }
}
function reset() {
  name.value = DEFAULT_PROFILE.name;
  color.value = DEFAULT_PROFILE.color;
  status.value = '';
}
</script>

<template>
  <div data-test="settings-name-color">
    <h1 class="st-h1">Your name &amp; color</h1>
    <p class="st-muted">
      Track changes works right away using a default name and color. Change them here if you like.
      Changing it here updates your future changes; changes you've already made keep their old
      label.
    </p>
    <label class="nc__flab" for="nc-name">Your name</label>
    <div class="nc__field">
      <input
        id="nc-name"
        v-model="name"
        class="nc__input"
        maxlength="64"
        data-test="settings-name"
      />
      <span v-if="name === DEFAULT_PROFILE.name" class="nc__kind">Default</span>
    </div>
    <div id="nc-color" class="nc__flab">Your color</div>
    <div class="nc__sw" role="radiogroup" aria-labelledby="nc-color">
      <button
        v-for="s in SWATCHES"
        :key="s.id"
        type="button"
        role="radio"
        class="nc__s"
        :class="{ 'nc__s--sel': color === s.id }"
        :aria-checked="color === s.id"
        :data-test="`swatch-${s.id}`"
        @click="color = s.id"
      >
        <i class="nc__dot" aria-hidden="true" :style="{ background: swatchVar(s.id) }">{{
          color === s.id ? '✓' : ''
        }}</i>
        <span
          >{{ s.name
          }}<small v-if="color === s.id"
            >Your color{{ s.id === DEFAULT_PROFILE.color ? ' · Default' : '' }}</small
          ></span
        >
      </button>
    </div>
    <div class="nc__preview">
      <span class="st-muted">Preview:</span>
      <ins
        class="nc__ins"
        :style="{
          textDecorationColor: swatchVar(color),
          background: `color-mix(in srgb, ${swatchVar(color)} 18%, transparent)`,
        }"
        >and set down</ins
      >
      <span class="nc__chip"
        ><span class="nc__av" :style="{ background: swatchVar(color) }">{{ name.charAt(0) }}</span
        ><bdi dir="auto">{{ name }}</bdi
        ><span class="nc__kind">Person</span></span
      >
    </div>
    <div class="nc__actions">
      <button type="button" class="st-btn st-btn--primary" data-test="settings-save" @click="save">
        Save
      </button>
      <button type="button" class="st-btn" data-test="settings-cancel" @click="emit('close')">
        Cancel
      </button>
      <button type="button" class="st-btn st-btn--link" data-test="settings-reset" @click="reset">
        Reset to default
      </button>
    </div>
    <p role="status" class="st-status" data-test="settings-name-status">{{ status }}</p>
  </div>
</template>

<style scoped>
.nc__flab {
  display: block;
  margin: var(--ct-space-6) 0 var(--ct-space-2);
  font-size: var(--ct-text-sm);
  font-weight: var(--ct-weight-semibold);
}
.nc__field {
  display: flex;
  align-items: center;
  gap: var(--ct-space-3);
  padding: 0 var(--ct-space-3);
  border: 1px solid var(--ct-border-strong);
  border-radius: var(--ct-radius-md);
  background: var(--ct-surface);
}
.nc__field:focus-within {
  box-shadow: var(--ct-focus-ring);
}
.nc__input {
  flex: 1;
  min-width: 0;
  min-height: var(--ct-space-12);
  border: 0;
  outline: 0;
  background: none;
  color: var(--ct-text);
  font: inherit;
}
.nc__kind {
  padding: 0 var(--ct-space-2);
  border: 1px solid var(--ct-border-strong);
  border-radius: var(--ct-radius-full);
  color: var(--ct-text-muted);
  font-size: var(--ct-text-xs);
  font-weight: var(--ct-weight-semibold);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
}
.nc__sw {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--ct-space-2);
}
.nc__s {
  display: flex;
  align-items: center;
  gap: var(--ct-space-2);
  padding: var(--ct-space-2);
  min-height: var(--ct-space-12);
  border: 1px solid var(--ct-border-strong);
  border-radius: var(--ct-radius-md);
  background: var(--ct-surface);
  color: var(--ct-text);
  font: inherit;
  font-size: var(--ct-text-sm);
  text-align: left;
  cursor: pointer;
}
.nc__s small {
  display: block;
  color: var(--ct-text-muted);
  font-size: var(--ct-text-xs);
}
.nc__s--sel {
  border: 2px solid var(--ct-text);
}
.nc__dot {
  flex: none;
  display: grid;
  place-items: center;
  width: var(--ct-space-6);
  height: var(--ct-space-6);
  border-radius: var(--ct-radius-full);
  color: var(--ct-surface);
  font-style: normal;
  font-size: var(--ct-text-xs);
}
.nc__preview {
  display: flex;
  align-items: center;
  gap: var(--ct-space-3);
  margin-top: var(--ct-space-6);
}
.nc__ins {
  font-family: var(--ct-font-manuscript);
  font-size: var(--ct-text-lg);
}
.nc__chip {
  display: inline-flex;
  align-items: center;
  gap: var(--ct-space-2);
  font-weight: var(--ct-weight-semibold);
  font-size: var(--ct-text-sm);
}
.nc__av {
  display: grid;
  place-items: center;
  width: var(--ct-space-6);
  height: var(--ct-space-6);
  border-radius: var(--ct-radius-full);
  color: var(--ct-surface);
  font-size: var(--ct-text-xs);
}
.nc__actions {
  display: flex;
  gap: var(--ct-space-3);
  margin-top: var(--ct-space-8);
}
</style>
