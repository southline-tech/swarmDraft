<script setup lang="ts">
/**
 * Comment threads sidebar (RAD-212, P1). Presentational: the host loads rows through a
 * `CommentsSource` and passes threads from `buildThreads`. Humans and agents can comment;
 * resolving and reopening here are human desktop actions.
 */
import { ref } from 'vue';
import { commentAuthorColor, type CommentThread } from '@coauthor/editor';

const props = defineProps<{ threads: CommentThread[]; showResolved?: boolean; busy?: boolean }>();
const emit = defineEmits<{
  reply: [threadId: string, body: string];
  resolve: [threadId: string, resolved: boolean];
  focus: [threadId: string];
}>();

const drafts = ref<Record<string, string>>({});
function send(id: string) {
  const body = (drafts.value[id] ?? '').trim();
  if (!body) return;
  emit('reply', id, body);
  drafts.value[id] = '';
}
const visible = () => props.threads.filter((t) => props.showResolved || !t.resolved);
</script>

<template>
  <aside class="comments" aria-label="Comments">
    <h2>Comments ({{ visible().length }})</h2>
    <p v-if="!visible().length" data-test="empty">No open comments.</p>
    <article
      v-for="t in visible()"
      :key="t.id"
      data-test="thread"
      :class="{ resolved: t.resolved, orphan: t.orphan !== 'none' }"
    >
      <blockquote data-test="anchor" @click="t.order >= 0 && emit('focus', t.id)">
        {{ t.anchorText || '(no text)' }}
      </blockquote>
      <p v-if="t.orphan === 'no_anchor'" data-test="orphan" class="warn">
        The text this comment pointed to was removed.
      </p>
      <p v-if="t.orphan === 'no_comments'" data-test="no-comments" class="warn">
        This highlight has no comments yet.
      </p>
      <ul>
        <li v-for="c in t.comments" :key="c.id" data-test="comment">
          <strong :style="{ color: commentAuthorColor(c.authorName) }">{{ c.authorName }}</strong>
          <span v-if="c.authorKind === 'agent'" class="badge">bot</span>
          {{ c.body }}
        </li>
      </ul>
      <form @submit.prevent="send(t.id)">
        <input
          v-model="drafts[t.id]"
          data-test="reply-input"
          placeholder="Reply"
          :disabled="busy"
        />
        <button data-test="reply" type="submit" :disabled="busy">Reply</button>
        <button
          data-test="resolve"
          type="button"
          :disabled="busy"
          @click="emit('resolve', t.id, !t.resolved)"
        >
          {{ t.resolved ? 'Reopen' : 'Resolve' }}
        </button>
      </form>
    </article>
  </aside>
</template>

<style scoped>
.resolved {
  opacity: 0.6;
}
.warn {
  color: #a35200;
  font-size: 0.85em;
}
.badge {
  font-size: 0.7em;
  border: 1px solid;
  border-radius: 3px;
  padding: 0 3px;
}
blockquote {
  cursor: pointer;
  margin: 0;
  font-style: italic;
}
</style>
