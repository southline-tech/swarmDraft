<script setup lang="ts">
/**
 * Review queue for tracked changes (RAD-211). Human-only: accept/reject is a desktop command,
 * never an agent tool. The panel is presentational; the host applies the decision through
 * `runDecision` from @coauthor/editor.
 */
import { computed } from 'vue';
import {
  authorColor,
  type Decision,
  type DecisionScope,
  type SuggestionItem,
} from '@coauthor/editor';

const props = defineProps<{ items: SuggestionItem[]; busy?: boolean }>();
const emit = defineEmits<{ decide: [scope: DecisionScope, decision: Decision] }>();

const authors = computed(() => [...new Set(props.items.map((i) => i.author))]);
const label = (i: SuggestionItem) => (i.kind === 'suggestion_insert' ? 'Insert' : 'Delete');
</script>

<template>
  <aside class="review" aria-label="Suggestions">
    <header>
      <h2>Suggestions ({{ items.length }})</h2>
      <div v-if="items.length" class="bulk">
        <button
          data-test="accept-all"
          :disabled="busy"
          @click="emit('decide', { kind: 'all' }, 'accept')"
        >
          Accept all
        </button>
        <button
          data-test="reject-all"
          :disabled="busy"
          @click="emit('decide', { kind: 'all' }, 'reject')"
        >
          Reject all
        </button>
      </div>
    </header>
    <p v-if="!items.length" data-test="empty">No open suggestions.</p>
    <section v-for="author in authors" :key="author" data-test="author-group">
      <h3 :style="{ color: authorColor(author) }">
        {{ author }}
        <button
          data-test="accept-author"
          :disabled="busy"
          @click="emit('decide', { kind: 'author', author }, 'accept')"
        >
          Accept all
        </button>
        <button
          data-test="reject-author"
          :disabled="busy"
          @click="emit('decide', { kind: 'author', author }, 'reject')"
        >
          Reject all
        </button>
      </h3>
      <ul>
        <li
          v-for="item in items.filter((i) => i.author === author)"
          :key="item.kind + item.id"
          data-test="item"
          :style="{ borderLeftColor: authorColor(author) }"
        >
          <span class="kind">{{ label(item) }}</span>
          <span :class="item.kind === 'suggestion_delete' ? 'del' : 'ins'">{{ item.text }}</span>
          <button
            data-test="accept"
            :disabled="busy"
            @click="emit('decide', { kind: 'one', id: item.id }, 'accept')"
          >
            Accept
          </button>
          <button
            data-test="reject"
            :disabled="busy"
            @click="emit('decide', { kind: 'one', id: item.id }, 'reject')"
          >
            Reject
          </button>
        </li>
      </ul>
    </section>
  </aside>
</template>

<style scoped>
li {
  border-left: 4px solid;
  padding-left: 0.5rem;
  list-style: none;
}
.del {
  text-decoration: line-through;
}
.ins {
  text-decoration: underline;
}
.kind {
  font-size: 0.8em;
  margin-right: 0.5rem;
}
</style>
