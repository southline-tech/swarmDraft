<script setup lang="ts">
/**
 * Comment threads sidebar (RAD-212, P1). Presentational: the host loads rows through a
 * `CommentsSource` and passes threads from `buildThreads`. Humans and agents can comment;
 * resolving and reopening here are human desktop actions.
 */
import { ref } from 'vue';
import EmptyState from '../shells/EmptyState.vue';
import { type CommentRow, type CommentThread } from '@swarmdraft/editor';
import { agentIdOf, agentName } from '../agent-names';
import { collabColor } from '../author-colors';

/** Agents show their current display name (RAD-263); people show the stored name. */
/** Color key (same raw id the review panel uses): agents by id (stable across renames), people by name. */
const colorKey = (c: CommentRow) =>
  c.authorKind === 'agent' ? `agent:${agentIdOf(c.authorId) ?? c.authorId}` : c.authorName;

const nameOf = (c: CommentRow) =>
  c.authorKind === 'agent'
    ? agentName(agentIdOf(c.authorId) ?? c.authorId, c.authorName)
    : { name: c.authorName, note: undefined, agent: false };

const props = defineProps<{
  threads: CommentThread[];
  showResolved?: boolean;
  busy?: boolean;
  /** Threads failed to load: never claim there are none (that would look like data loss). */
  loadFailed?: boolean;
}>();
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
    <p v-if="!visible().length && loadFailed" class="muted" data-test="empty-load-failed">
      Comments couldn't be loaded.
    </p>
    <EmptyState
      v-else-if="!visible().length"
      data-test="empty"
      icon="comment"
      title="No comments yet"
      text="Select some text and choose Comment to leave yourself a note."
    />
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
          <strong
            class="comment-author agent-label"
            :style="{ borderLeftColor: collabColor(colorKey(c)) }"
            data-test="comment-author"
            ><template v-for="n in [nameOf(c)]" :key="n.name"
              ><bdi class="agent-name" dir="auto" data-test="agent-name" :title="n.name">{{
                n.name
              }}</bdi
              ><span v-if="n.agent" class="agent-tag" data-test="agent-tag">Bot</span>
              <template v-if="n.note"
                >{{ ' '
                }}<span class="agent-note" data-test="agent-note">{{ n.note }}</span></template
              ></template
            ></strong
          >
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
.comment-author {
  color: var(--ct-text);
  border-left: 3px solid;
  padding-left: 0.35rem;
}
.resolved {
  opacity: 0.6;
}
.warn {
  color: var(--ct-warning);
  font-size: 0.85em;
}
blockquote {
  cursor: pointer;
  margin: 0;
  font-style: italic;
}
</style>
