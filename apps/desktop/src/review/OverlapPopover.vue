<script setup lang="ts">
/** All-view overlap popover (#179): list overlapping suggestions, Accept/Reject each. */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Decision, SuggestionItem } from '@swarmdraft/editor';
import { authorKind } from './review-state';
import type { AgentName } from '../agent-names';
import { collabColor } from '../author-colors';

export interface OverlapEntry {
  targets: { kind: SuggestionItem['kind']; id: string }[];
  author: string;
  del?: string;
  ins?: string;
  format?: string;
  ts: string;
}

const props = defineProps<{
  x: number;
  y: number;
  entries: readonly OverlapEntry[];
  busy?: boolean;
  labels?: (author: string) => AgentName;
}>();
const emit = defineEmits<{
  close: [];
  decide: [targets: OverlapEntry['targets'], decision: Decision];
}>();

const root = ref<HTMLElement | null>(null);
const opener = document.activeElement as HTMLElement | null;

const sorted = computed(() =>
  [...props.entries].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)),
);

const parts = (a: string) =>
  (props.labels ?? ((id) => ({ name: id, agent: id.startsWith('agent:') })))(a);
const initial = (a: string) => (parts(a).name[0] ?? '?').toUpperCase();
const hue = (a: string) => ({ '--ct-suggester': collabColor(a) });

function focusables() {
  return [...(root.value?.querySelectorAll<HTMLElement>('[data-overlap-row]') ?? [])];
}

function restoreEditorFocus() {
  void nextTick(() => {
    const page = document.querySelector<HTMLElement>('.manuscript-editor .ProseMirror');
    (page ?? opener)?.focus?.();
  });
}

function onKey(e: KeyboardEvent) {
  const items = focusables();
  const active = document.activeElement as HTMLElement | null;
  const i = items.indexOf(active as HTMLElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? Math.min(i + 1, items.length - 1) : Math.max(i - 1, 0);
    items[next]?.focus();
    return;
  }
  if (e.key === 'Escape') {
    e.stopPropagation();
    emit('close');
    restoreEditorFocus();
  }
}

watch(
  () => props.entries,
  () => void nextTick(() => focusables()[0]?.focus()),
);

onMounted(() => void nextTick(() => focusables()[0]?.focus()));
onBeforeUnmount(restoreEditorFocus);
</script>

<template>
  <div
    ref="root"
    class="sh-menu overlap-popover"
    role="dialog"
    aria-modal="true"
    aria-label="Overlapping suggestions"
    data-test="overlap-popover"
    :style="{ left: `${x}px`, top: `${y}px` }"
    @keydown="onKey"
  >
    <ul class="overlap-list">
      <li
        v-for="(e, idx) in sorted"
        :key="`${e.author}-${e.targets[0]?.id ?? idx}`"
        class="overlap-row"
        data-overlap-row
        tabindex="0"
        data-test="overlap-row"
      >
        <div class="who" :style="hue(e.author)">
          <span class="av" aria-hidden="true">{{ initial(e.author) }}</span>
          <bdi class="name" dir="auto">{{ parts(e.author).name }}</bdi>
          <span class="pill">{{ authorKind(e.author) }}</span>
        </div>
        <p v-if="e.format" class="format">{{ e.format }}</p>
        <p v-else class="q">
          <span v-if="e.del" class="del">{{ e.del }}</span
          ><template v-if="e.del && e.ins">{{ ' ' }}</template
          ><span v-if="e.ins" class="ins">{{ e.ins }}</span>
        </p>
        <div class="actions">
          <button
            type="button"
            class="primary sh-btn"
            data-test="overlap-accept"
            :disabled="busy"
            @click="emit('decide', e.targets, 'accept')"
          >
            Accept
          </button>
          <button
            type="button"
            class="secondary sh-btn"
            data-test="overlap-reject"
            :disabled="busy"
            @click="emit('decide', e.targets, 'reject')"
          >
            Reject
          </button>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.overlap-popover {
  position: fixed;
  min-width: 18rem;
  max-width: 24rem;
  max-height: min(60vh, 420px);
  overflow-y: auto;
  padding: var(--ct-space-2);
}
.overlap-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-2);
}
.overlap-row {
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-md);
  padding: var(--ct-space-2);
  background: var(--ct-surface-raised);
}
.overlap-row:focus-visible {
  outline: var(--ct-focus-outline);
  outline-offset: var(--ct-focus-offset);
}
.who {
  display: flex;
  align-items: center;
  gap: var(--ct-space-2);
  font-weight: var(--ct-weight-semibold);
  margin-bottom: var(--ct-space-1);
}
.av {
  width: 24px;
  height: 24px;
  border-radius: var(--ct-radius-full);
  background: var(--ct-suggester);
  color: var(--ct-accent-contrast);
  display: grid;
  place-items: center;
  font-size: var(--ct-text-sm);
}
.pill {
  font-size: var(--ct-text-xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 2px var(--ct-space-2);
  border-radius: var(--ct-radius-full);
  border: 1px solid var(--ct-border-strong);
  color: var(--ct-text-muted);
}
.q {
  margin: var(--ct-space-1) 0;
  font-family: var(--ct-font-manuscript);
}
.q .ins {
  background: var(--ct-suggest-insert-bg);
  text-decoration: underline 2px var(--ct-suggest-insert-underline);
}
.q .del {
  color: var(--ct-suggest-delete-text);
  text-decoration: line-through 2px var(--ct-suggest-delete-strike);
}
.format {
  margin: var(--ct-space-1) 0;
  font-weight: var(--ct-weight-semibold);
}
.actions {
  display: flex;
  gap: var(--ct-space-2);
  margin-top: var(--ct-space-2);
}
</style>
