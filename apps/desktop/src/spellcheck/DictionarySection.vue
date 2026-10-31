<script setup lang="ts">
/** Settings → Spelling (#159 sc4–sc6): toggles and per-manuscript dictionary. */
import { computed, ref, watch } from 'vue';
import { spellDictionaryAdd, spellDictionaryList, spellDictionaryRemove } from '../backend';
import { loadSpellPrefs, saveSpellPrefs, type SpellPrefs } from '../settings/prefs';

const props = defineProps<{
  manuscriptId?: string;
  backendAvailable: boolean;
}>();

const prefs = ref<SpellPrefs>(loadSpellPrefs());
const query = ref('');
const addWord = ref('');
const words = ref<string[]>([]);
const status = ref('');
const loading = ref(false);

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return words.value;
  return words.value.filter((w) => w.includes(q));
});

function persistPrefs() {
  prefs.value = saveSpellPrefs(prefs.value);
}

async function reload() {
  if (!props.backendAvailable || !props.manuscriptId) {
    words.value = [];
    return;
  }
  loading.value = true;
  status.value = '';
  try {
    words.value = await spellDictionaryList(props.manuscriptId);
  } catch {
    status.value = 'Could not load the dictionary.';
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.manuscriptId,
  () => void reload(),
  { immediate: true },
);

async function submitAddWord() {
  const word = addWord.value.trim();
  if (!word || !props.manuscriptId) return;
  status.value = '';
  try {
    await spellDictionaryAdd(props.manuscriptId, word);
    addWord.value = '';
    await reload();
  } catch {
    status.value = 'Could not add that word.';
  }
}

async function removeWord(word: string) {
  if (!props.manuscriptId) return;
  await spellDictionaryRemove(props.manuscriptId, word);
  await reload();
}
</script>

<template>
  <div data-test="settings-spelling">
    <h1 class="st-h1">Spelling &amp; grammar</h1>
    <p class="st-muted st-sub">
      Check this manuscript as you write. Checking runs on your computer; nothing leaves the
      machine.
    </p>
    <section class="st-card" aria-labelledby="st-spell-toggles">
      <h2 id="st-spell-toggles" class="st-h2">Checking</h2>
      <div class="st-row st-row--toggle">
        <span id="spell-spelling-label" class="st-row__k">Spelling</span>
        <input
          id="spell-spelling"
          v-model="prefs.spelling"
          type="checkbox"
          role="switch"
          class="st-switch"
          :aria-checked="prefs.spelling ? 'true' : 'false'"
          aria-labelledby="spell-spelling-label"
          data-test="spell-toggle-spelling"
          @change="persistPrefs"
        />
      </div>
      <p class="st-muted st-desc">Red wavy underline on words that aren't in the dictionary</p>
      <div class="st-row st-row--toggle">
        <span id="spell-grammar-label" class="st-row__k">Grammar</span>
        <input
          id="spell-grammar"
          v-model="prefs.grammar"
          type="checkbox"
          role="switch"
          class="st-switch"
          :aria-checked="prefs.grammar ? 'true' : 'false'"
          aria-labelledby="spell-grammar-label"
          data-test="spell-toggle-grammar"
          @change="persistPrefs"
        />
      </div>
      <p class="st-muted st-desc">Green wavy underline on grammar issues</p>
    </section>
    <section v-if="manuscriptId && backendAvailable" class="st-card" aria-labelledby="st-dict">
      <h2 id="st-dict" class="st-h2">Dictionary for this manuscript</h2>
      <p v-if="!loading && !words.length" class="st-muted st-desc" data-test="dict-empty">
        No words in this manuscript's dictionary yet. Add character names, places, and invented
        terms so they aren't flagged.
      </p>
      <p v-else-if="words.length" class="st-muted st-desc">
        Words you add stop being flagged as spelling mistakes. The dictionary applies only to this
        manuscript.
      </p>
      <form class="st-row st-row--add" @submit.prevent="submitAddWord">
        <label class="st-row__k" for="dict-add">Add word</label>
        <input
          id="dict-add"
          v-model="addWord"
          class="st-inp"
          type="text"
          autocomplete="off"
          placeholder="Type a word"
          data-test="dict-add"
        />
        <button type="submit" class="st-btn st-btn--s" data-test="dict-add-submit">Add</button>
      </form>
      <label class="st-row" for="dict-search">
        <span class="st-row__k">Search</span>
        <input
          id="dict-search"
          v-model="query"
          class="st-inp"
          type="search"
          placeholder="Filter words"
          data-test="dict-search"
        />
      </label>
      <p v-if="loading" class="st-muted" role="status">Loading…</p>
      <ul v-else-if="words.length" class="dict-list" data-test="dict-list">
        <li v-for="w in filtered" :key="w" class="dict-list__row">
          <bdi dir="auto">{{ w }}</bdi>
          <button
            type="button"
            class="st-btn st-btn--s"
            :aria-label="`Remove ${w}`"
            :data-test="`dict-remove-${w}`"
            @click="removeWord(w)"
          >
            Remove
          </button>
        </li>
      </ul>
      <p v-if="status" role="status" class="st-status">{{ status }}</p>
    </section>
    <div v-else-if="!backendAvailable" class="st-ban st-ban--w">
      <b>Running in browser mode.</b> Dictionary storage needs the desktop app.
    </div>
    <p v-else class="st-muted">Open a book to manage its dictionary.</p>
  </div>
</template>

<style scoped>
.st-row--toggle {
  align-items: center;
}
.st-row--add {
  align-items: center;
}
.dict-list {
  margin: var(--ct-space-4) 0 0;
  padding: 0;
  list-style: none;
}
.dict-list__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ct-space-3);
  min-height: var(--ct-space-12);
  padding: var(--ct-space-2) 0;
  border-bottom: 1px solid var(--ct-border);
}
</style>
