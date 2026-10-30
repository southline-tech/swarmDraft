<script setup lang="ts">
/**
 * Preview-only workspace mock for wp1/wp6, wp2, wp8 and tc4/tc6 (Part of #36). Static sample data; it never
 * touches a manuscript, Yjs doc, storage or IPC. Buttons only report "preview only".
 */
import { computed, ref } from 'vue';
import { swatchVar } from './colors';
import PanelRail from '../desk/PanelRail.vue';

const props = defineProps<{ mode: 'wp1' | 'wp2' | 'wp8' | 'tc4' }>();
const emit = defineEmits<{ stub: [what: string] }>();
const filter = ref<'all' | 'person' | 'bot'>('all');

const chapters = [
  ['Sample Chapter One', '3,412'],
  ['Sample Chapter Two', '2,987'],
  ['The Low Tide', '2,154'],
  ['Sample Chapter Four', '3,040'],
  ['Sample Chapter Five', '2,611'],
] as const;

const changes = [
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
  { who: 'Sample Person', bot: false, color: 2, del: '', ins: 'else', reason: '' },
] as const;
const shown = computed(() =>
  changes.filter((c) => filter.value === 'all' || (filter.value === 'bot') === c.bot),
);
const step = ref(3);
const authors = ref([
  { who: 'Writing assistant', n: 9, on: true, color: 1 },
  { who: 'Sample Person', n: 3, on: true, color: 2 },
  { who: 'Sample Reader', n: 2, on: false, color: 3 },
]);
const visible = computed(() => authors.value.filter((a) => a.on).reduce((t, a) => t + a.n, 0));
const onCount = computed(() => authors.value.filter((a) => a.on).length);
const go = (d: number) => {
  step.value = Math.min(Math.max(1, step.value + d), Math.max(1, visible.value));
};
const count = (bot: boolean) => changes.filter((c) => c.bot === bot).length;
</script>

<template>
  <div
    class="pw"
    :class="{ 'pw--rails': props.mode === 'wp2' }"
    :data-test="`preview-${props.mode}`"
  >
    <PanelRail
      v-if="props.mode === 'wp2'"
      side="left"
      expand-label="Show chapters"
      glyph="☰"
      data-test="preview-outline-rail"
      @expand="emit('stub', 'Show chapters')"
    />
    <aside v-else class="pw__nav" aria-label="Chapters (sample)">
      <p class="pw__cap">Chapters</p>
      <ol>
        <li
          v-for="([t, n], i) in chapters"
          :key="t"
          :class="{ pw__sel: i === (props.mode === 'tc4' ? 0 : 2) }"
        >
          <span>{{ i + 1 }}</span
          ><span class="pw__t">{{ t }}</span
          ><span v-if="props.mode !== 'tc4'" class="pw__n">{{ n }}</span>
        </li>
      </ol>
      <p class="pw__new">+ New chapter</p>
    </aside>

    <main class="pw__desk">
      <article class="pw__page">
        <template v-if="props.mode !== 'tc4'">
          <p class="pw__label">Chapter Three</p>
          <h1 class="pw__h1">The Low Tide</h1>
          <p>
            The tide went out the way it always did, slowly and then all at once, leaving the harbor
            floor bare and shining under a
            <span :class="{ pw__cur: props.mode === 'wp8' }"
              ><del class="pw__del">very quiet</del> <ins class="pw__ins">hushed</ins></span
            >
            sky. Gulls worked the mud in pairs.
          </p>
          <p>
            Up on the point, the <mark class="pw__comment">lamp</mark> in the old tower was dark, as
            it had been since March.
          </p>
        </template>
        <template v-else>
          <h1 class="pw__h1">Chapter One</h1>
          <p>
            She opened it each evening at the turning of the lamp,
            <del class="pw__del pw__del--p">and wrote down</del
            ><ins class="pw__ins pw__ins--p">and set down</ins> the weather, the ships, and anything
            <ins class="pw__ins pw__ins--p">else</ins> the sea had seen fit to return.
          </p>
          <p>
            The ledger had been kept for <del class="pw__del">forty-one</del
            ><ins class="pw__ins">forty</ins> years.
          </p>
        </template>
      </article>
    </main>

    <div v-if="props.mode === 'wp2'" class="pw__pill" data-test="margin-pill">
      <b>Writing assistant</b
      ><span class="pw__muted">Suggested, not applied. Review to accept.</span>
    </div>
    <PanelRail
      v-if="props.mode === 'wp2'"
      side="right"
      expand-label="Show review"
      :badge="3"
      data-test="preview-review-rail"
      @expand="emit('stub', 'Show review')"
    />
    <aside v-else class="pw__review" aria-label="Review (sample)">
      <template v-if="props.mode === 'wp8'">
        <p class="pw__cap">Review</p>
        <p class="pw__sel pw__drop">Show changes from {{ onCount }} of {{ authors.length }}</p>
        <fieldset class="pw__authors">
          <legend class="pw__muted">Show changes from</legend>
          <label v-for="a in authors" :key="a.who">
            <input v-model="a.on" type="checkbox" @change="go(0)" />
            <span class="pw__dot" :style="{ background: swatchVar(a.color) }"></span>
            <bdi dir="auto">{{ a.who }}</bdi
            ><span class="pw__n">{{ a.n }}</span>
          </label>
        </fieldset>
        <article class="pw__card pw__step" :style="{ borderLeftColor: swatchVar(1) }">
          <div class="pw__nav2">
            <button type="button" class="sh-btn" aria-label="Previous change" @click="go(-1)">
              ‹
            </button>
            <span data-test="step-pos">{{ Math.min(step, visible) }} of {{ visible }}</span>
            <button type="button" class="sh-btn" aria-label="Next change" @click="go(1)">›</button>
          </div>
          <b>Writing assistant</b> <span class="pw__muted">Replace</span>
          <p>Replace “very quiet” with “hushed”</p>
          <div class="pw__act">
            <button type="button" class="sh-btn sh-btn--primary" @click="emit('stub', 'Accept')">
              ✓ Accept
            </button>
            <button type="button" class="sh-btn" @click="emit('stub', 'Reject')">✕ Reject</button>
          </div>
        </article>
        <div class="pw__act">
          <button type="button" class="sh-btn" @click="emit('stub', 'Accept all')">
            Accept all {{ visible }}
          </button>
          <button type="button" class="sh-btn" @click="emit('stub', 'Reject all')">
            Reject all {{ visible }}
          </button>
        </div>
        <dl class="pw__keys pw__muted">
          <dt><kbd>Alt</kbd><kbd>Shift</kbd><kbd>←</kbd><kbd>→</kbd></dt>
          <dd>previous / next</dd>
          <dt><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>Enter</kbd></dt>
          <dd>accept</dd>
          <dt><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>⌫</kbd></dt>
          <dd>reject</dd>
        </dl>
        <p class="pw__muted">
          Accept and Reject move to the next change. Bulk actions apply only to the {{ visible }}
          visible changes.
        </p>
      </template>
      <template v-else-if="props.mode === 'wp1'">
        <p class="pw__cap">Review · Open 3</p>
        <article class="pw__card" :style="{ borderLeftColor: swatchVar(1) }">
          <b>Writing assistant</b> <span class="pw__muted">Suggestion</span>
          <p>Replace “very quiet” with “hushed”</p>
          <div class="pw__act">
            <button type="button" class="sh-btn sh-btn--primary" @click="emit('stub', 'Accept')">
              Accept
            </button>
            <button type="button" class="sh-btn" @click="emit('stub', 'Reject')">Reject</button>
          </div>
        </article>
        <article class="pw__card" :style="{ borderLeftColor: swatchVar(2) }">
          <b>Sample Person</b> <span class="pw__muted">2h ago</span>
          <p>Love this image. Could the lamp be named earlier?</p>
          <div class="pw__act">
            <button type="button" class="sh-btn">Reply</button
            ><button type="button" class="sh-btn">Resolve</button>
          </div>
        </article>
        <article class="pw__card" :style="{ borderLeftColor: swatchVar(3) }">
          <b>Sample Reader</b> <span class="pw__muted">Yesterday</span>
          <p>Tense slips to present in the last line of this paragraph.</p>
          <div class="pw__act">
            <button type="button" class="sh-btn">Reply</button
            ><button type="button" class="sh-btn">Resolve</button>
          </div>
        </article>
      </template>
      <template v-else>
        <h2 class="pw__h2">
          Review changes <span class="pw__muted">1 of {{ changes.length }}</span>
        </h2>
        <p class="pw__cap">Show changes from</p>
        <div role="radiogroup" aria-label="Show changes from" class="pw__filter">
          <button
            type="button"
            role="radio"
            :aria-checked="filter === 'all'"
            @click="filter = 'all'"
          >
            Everyone <span>{{ changes.length }}</span>
          </button>
          <button
            type="button"
            role="radio"
            :aria-checked="filter === 'person'"
            @click="filter = 'person'"
          >
            Sample Person <em>Person</em> <span>{{ count(false) }}</span>
          </button>
          <button
            type="button"
            role="radio"
            :aria-checked="filter === 'bot'"
            @click="filter = 'bot'"
          >
            Sample Bot <em>Bot</em> <span>{{ count(true) }}</span>
          </button>
        </div>
        <article
          v-for="(c, i) in shown"
          :key="i"
          class="pw__card"
          :style="{ borderLeftColor: swatchVar(c.color) }"
        >
          <b
            ><bdi dir="auto">{{ c.who }}</bdi></b
          >
          <em class="pw__kind">{{ c.bot ? 'Bot' : 'Person' }}</em>
          <p>
            <del v-if="c.del">{{ c.del }}</del> <ins>{{ c.ins }}</ins
            ><span v-if="!c.del" class="pw__muted"> (added)</span>
          </p>
          <p v-if="c.reason" class="pw__muted">{{ c.reason }}</p>
          <div class="pw__act">
            <button type="button" class="sh-btn sh-btn--primary" @click="emit('stub', 'Accept')">
              Accept
            </button>
            <button type="button" class="sh-btn" @click="emit('stub', 'Reject')">Reject</button>
          </div>
        </article>
      </template>
    </aside>
  </div>
</template>

<style scoped>
.pw {
  display: grid;
  grid-template-columns: 220px 1fr 300px;
  min-height: 720px;
  border: 1px solid var(--ct-border);
  background: var(--ct-bg);
}
.pw__nav,
.pw__review {
  background: var(--ct-surface);
  padding: 12px;
  font-size: var(--ct-text-sm);
  overflow: auto;
}
.pw__nav {
  border-right: 1px solid var(--ct-border);
}
.pw__review {
  border-left: 1px solid var(--ct-border);
}
.pw__nav ol {
  list-style: none;
  margin: 0;
  padding: 0;
}
.pw__nav li {
  display: flex;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--ct-radius-sm);
}
.pw__sel {
  background: var(--ct-selected-bg);
}
.pw__t {
  flex: 1;
}
.pw__n,
.pw__muted {
  color: var(--ct-text-muted);
  font-size: var(--ct-text-xs);
}
.pw__new {
  color: var(--ct-text-muted);
  padding: 6px 8px;
}
.pw__cap {
  color: var(--ct-text-muted);
  font-size: var(--ct-text-xs);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin: 0 0 8px;
}
.pw__desk {
  display: flex;
  justify-content: center;
  padding: 24px;
}
.pw__page {
  width: min(100%, var(--ct-measure-page));
  background: var(--ct-paper);
  color: var(--ct-text-page);
  padding: 56px 52px;
  font-family: var(--ct-font-manuscript);
  line-height: var(--ct-leading-body);
  box-shadow: 0 1px 3px var(--ct-scrim);
}
.pw__label {
  text-align: center;
  font-variant: small-caps;
  letter-spacing: 0.18em;
  color: var(--ct-text-muted);
  font-size: var(--ct-text-sm);
  margin: 0;
}
.pw__h1 {
  text-align: center;
  font-weight: 400;
  font-size: var(--ct-text-xl);
  margin: 4px 0 24px;
}
.pw__del {
  background: var(--ct-suggest-delete-bg);
  color: var(--ct-suggest-delete-text);
  text-decoration-color: var(--ct-suggest-delete-strike);
}
.pw__ins {
  background: var(--ct-suggest-insert-bg);
  text-decoration-color: var(--ct-suggest-insert-underline);
}
.pw__del--p,
.pw__ins--p {
  background: var(--ct-warning-bg);
}
.pw__comment {
  background: var(--ct-comment-bg);
  color: inherit;
}
.pw__card {
  border: 1px solid var(--ct-border);
  border-left-width: 3px;
  border-radius: var(--ct-radius-md);
  background: var(--ct-surface-raised);
  padding: 10px 12px;
  margin-bottom: 10px;
}
.pw__card p {
  margin: 6px 0;
}
.pw__act {
  display: flex;
  gap: 8px;
}
.pw__h2 {
  display: flex;
  justify-content: space-between;
  font-size: var(--ct-text-lg);
  margin: 0 0 10px;
}
.pw__filter {
  display: grid;
  gap: 4px;
  margin-bottom: 12px;
}
.pw__filter button {
  display: flex;
  gap: 8px;
  align-items: center;
  text-align: left;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--ct-radius-sm);
  background: transparent;
  color: inherit;
  font: inherit;
}
.pw__filter button[aria-checked='true'] {
  background: var(--ct-selected-bg);
}
.pw__filter span {
  margin-left: auto;
  color: var(--ct-text-muted);
}
.pw__filter em,
.pw__kind {
  font-style: normal;
  font-size: var(--ct-text-xs);
  text-transform: uppercase;
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-full);
  padding: 0 6px;
}
.pw--rails {
  grid-template-columns: 40px 1fr 40px;
  position: relative;
}
.pw__rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  background: var(--ct-surface);
  border-right: 1px solid var(--ct-border);
}
.pw__rail--r {
  border-right: 0;
  border-left: 1px solid var(--ct-border);
}
.pw__icon {
  border: 0;
  background: transparent;
  color: var(--ct-text-muted);
  font: inherit;
}
.pw__badge {
  background: var(--ct-accent);
  color: var(--ct-accent-contrast);
  border-radius: var(--ct-radius-full);
  font-size: var(--ct-text-xs);
  padding: 0 6px;
}
.pw__pill {
  position: absolute;
  right: 120px;
  top: 170px;
  display: grid;
  max-width: 140px;
  padding: 6px 10px;
  font-size: var(--ct-text-xs);
  background: var(--ct-surface-raised);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-md);
}
.pw__cur {
  outline: 2px solid var(--ct-accent);
  border-radius: var(--ct-radius-sm);
}
.pw__drop {
  padding: 6px 8px;
  border: 1px solid var(--ct-accent);
  border-radius: var(--ct-radius-sm);
}
.pw__authors {
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-md);
  margin: 0 0 10px;
  padding: 6px 8px;
}
.pw__authors label {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
}
.pw__authors .pw__n {
  margin-left: auto;
}
.pw__dot {
  width: 8px;
  height: 8px;
  border-radius: var(--ct-radius-full);
}
.pw__nav2 {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.pw__keys {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 8px;
}
.pw__keys dd {
  margin: 0;
}
.pw__keys kbd {
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-sm);
  padding: 0 4px;
  margin-right: 2px;
}
</style>
