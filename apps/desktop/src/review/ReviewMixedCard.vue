<script setup lang="ts">
import ReasonLine from '../shells/ReasonLine.vue';
import {
  OUTDATED_CARD_EXPLANATION,
  authorKind,
  outdatedCardAriaLabel,
  REVIEW_SHORTCUTS,
} from './review-state';
import type { ReviewListItem } from './review-inline';
import { agentIdOf, agentName, type AgentName } from '../agent-names';
import { collabColor } from '../author-colors';

const props = defineProps<{
  item: ReviewListItem;
  currentKey: string | null;
  activeScrollKey: string | null;
  busy?: boolean;
  labels: (author: string) => AgentName;
  draft?: string;
}>();

const emit = defineEmits<{
  activate: [key: string, e: Event];
  'decide-one': [key: string, decision: 'accept' | 'reject'];
  'dismiss-one': [key: string];
  'comment-reply': [threadId: string, body: string];
  'comment-resolve': [threadId: string, resolved: boolean];
  'update:draft': [threadId: string, value: string];
}>();

const parts = (a: string) => props.labels(a);
const name = (a: string) => {
  const n = parts(a);
  return n.note ? `${n.name} ${n.note}` : n.name;
};
const initial = (a: string) => (parts(a).name[0] ?? '?').toUpperCase();
const hue = (a: string) => ({ '--ct-suggester': collabColor(a) });

const c = () => (props.item.kind === 'suggestion' ? props.item.change : null);

const commentName = (row: {
  authorKind: string;
  authorId: string;
  authorName: string;
}): AgentName =>
  row.authorKind === 'agent'
    ? agentName(agentIdOf(row.authorId) ?? row.authorId, row.authorName)
    : { name: row.authorName, note: undefined, agent: false };

const colorKeyOfComment = (row: { authorKind: string; authorId: string; authorName: string }) =>
  row.authorKind === 'agent' ? `agent:${agentIdOf(row.authorId) ?? row.authorId}` : row.authorName;

const rootComment = () =>
  props.item.kind === 'comment' ? props.item.thread.comments[0] : undefined;

const rowLabel = () => {
  if (props.item.kind === 'comment') {
    const root = rootComment();
    return root ? `Comment by ${commentName(root).name}` : 'Comment';
  }
  const ch = c()!;
  if (ch.outdated) return outdatedCardAriaLabel(name(ch.author), ch);
  return `Suggestion by ${name(ch.author)}`;
};

const shownReplies = () => {
  const all = props.item.kind === 'comment' ? props.item.thread.comments : [];
  return { shown: all.slice(0, 2), more: Math.max(0, all.length - 2) };
};

function submitReply() {
  if (props.item.kind !== 'comment') return;
  const body = (props.draft ?? '').trim();
  if (body) emit('comment-reply', props.item.thread.id, body);
}

const tip = (text: string, keys: string) => `${text} (${keys})`;
</script>

<template>
  <li
    :ref="undefined"
    class="card"
    :class="{
      current: item.key === currentKey,
      active: item.key === activeScrollKey,
      outdated: item.kind === 'suggestion' && !!item.change.outdated,
      'card--comment': item.kind === 'comment',
      'card--resolved': item.kind === 'comment' && item.thread.resolved,
    }"
    :style="
      item.kind === 'suggestion'
        ? hue(item.change.author)
        : hue(
            colorKeyOfComment(
              rootComment() ?? { authorKind: 'human', authorId: '', authorName: '?' },
            ),
          )
    "
    :data-suggester="item.kind === 'suggestion' ? '' : undefined"
    :data-kind="item.kind"
    :data-test="item.kind === 'suggestion' ? 'item' : 'review-item'"
    :data-comment-id="item.kind === 'comment' ? item.thread.id : undefined"
    :data-review-row-key="item.key"
    role="option"
    :aria-selected="item.key === currentKey ? 'true' : 'false'"
    :aria-current="item.key === activeScrollKey ? 'true' : undefined"
    :aria-label="rowLabel()"
    tabindex="-1"
    @click="emit('activate', item.key, $event)"
  >
    <span
      v-if="item.key === activeScrollKey"
      class="visually-hidden"
      data-test="review-row-active"
      aria-hidden="true"
    />

    <template v-if="item.kind === 'suggestion'">
      <div class="who">
        <span class="av" aria-hidden="true">{{ initial(item.change.author) }}</span>
        <bdi class="name" dir="auto" data-test="agent-name" :title="name(item.change.author)">{{
          parts(item.change.author).name
        }}</bdi>
        <span v-if="parts(item.change.author).note" class="note" data-test="agent-note">{{
          parts(item.change.author).note
        }}</span>
        <span class="pill">{{ authorKind(item.change.author) }}</span>
      </div>
      <p v-if="item.change.outdated" class="outdated-head">
        <span class="pill outdated-badge" data-test="outdated-pill">Outdated</span>
      </p>
      <p v-if="item.change.outdated" class="outdated-note" data-test="outdated-note">
        {{ OUTDATED_CARD_EXPLANATION }}
      </p>
      <p v-if="item.change.format" class="format" data-test="format">
        {{ item.change.format.label }}
      </p>
      <p v-else class="q">
        <span v-if="item.change.del" class="del" data-test="del">{{ item.change.del }}</span
        ><template v-if="item.change.del && item.change.ins">{{ ' ' }}</template
        ><span v-if="item.change.ins" class="ins" data-test="ins">{{ item.change.ins }}</span>
      </p>
      <div
        v-if="authorKind(item.change.author) === 'Bot' && item.change.reason"
        class="reason"
        @click.stop
      >
        <ReasonLine :reason="item.change.reason" />
      </div>
      <div v-if="item.change.outdated" class="actions">
        <button
          type="button"
          class="secondary"
          data-test="dismiss"
          :disabled="busy"
          @click.stop="emit('dismiss-one', item.key)"
        >
          Dismiss
        </button>
      </div>
      <div v-else class="actions">
        <button
          type="button"
          class="primary"
          data-test="accept"
          :disabled="busy"
          :title="tip('Accept change', REVIEW_SHORTCUTS.accept)"
          @click.stop="emit('decide-one', item.key, 'accept')"
        >
          Accept
        </button>
        <button
          type="button"
          class="secondary"
          data-test="reject"
          :disabled="busy"
          :title="tip('Reject change', REVIEW_SHORTCUTS.reject)"
          @click.stop="emit('decide-one', item.key, 'reject')"
        >
          Reject
        </button>
      </div>
    </template>

    <template v-else-if="item.kind === 'comment'">
      <div class="who">
        <span
          class="av"
          aria-hidden="true"
          :style="{ '--ct-suggester': collabColor(colorKeyOfComment(rootComment()!)) }"
          >{{ (commentName(rootComment()!).name[0] ?? '?').toUpperCase() }}</span
        >
        <bdi class="name" dir="auto" data-test="agent-name">{{
          commentName(rootComment()!).name
        }}</bdi>
        <span v-if="commentName(rootComment()!).note" class="note" data-test="agent-note">{{
          commentName(rootComment()!).note
        }}</span>
        <span class="pill comment-pill">Comment</span>
      </div>
      <blockquote class="comment-quote" data-test="comment-quote">
        {{ item.thread.anchorText || (item.thread.orphan === 'no_anchor' ? '(removed)' : '') }}
      </blockquote>
      <p v-if="item.thread.orphan === 'no_anchor'" class="warn" data-test="orphan-warn">
        The text this comment pointed to was removed.
      </p>
      <ul class="comment-thread">
        <li v-for="reply in shownReplies().shown" :key="reply.id" data-test="comment-body">
          <strong
            class="comment-author"
            :style="{ borderLeftColor: collabColor(colorKeyOfComment(reply)) }"
            ><bdi dir="auto">{{ commentName(reply).name }}</bdi></strong
          >
          {{ reply.body }}
        </li>
        <li v-if="shownReplies().more" class="replies-more" data-test="replies-more">
          {{ shownReplies().more }} more repl{{ shownReplies().more === 1 ? 'y' : 'ies' }}
        </li>
      </ul>
      <form class="comment-actions" @submit.prevent="submitReply">
        <input
          :value="draft"
          data-test="reply-input"
          placeholder="Reply"
          :disabled="busy"
          @input="
            item.kind === 'comment' &&
            emit('update:draft', item.thread.id, ($event.target as HTMLInputElement).value)
          "
        />
        <button data-test="reply" type="submit" :disabled="busy">Reply</button>
        <button
          data-test="resolve"
          type="button"
          :disabled="busy"
          @click.stop="
            item.kind === 'comment' &&
            emit('comment-resolve', item.thread.id, !item.thread.resolved)
          "
        >
          {{ item.thread.resolved ? 'Reopen' : 'Resolve' }}
        </button>
      </form>
    </template>
  </li>
</template>

<style scoped>
.comment-pill {
  color: var(--ct-text-muted);
}
.comment-quote {
  margin: var(--ct-space-2) 0;
  padding: var(--ct-space-2) var(--ct-space-3);
  border-radius: var(--ct-radius-sm);
  background: var(--ct-comment-bg);
  font-family: var(--ct-font-manuscript);
  font-style: italic;
}
.warn {
  color: var(--ct-warning);
  font-size: var(--ct-text-sm);
  margin: 0 0 var(--ct-space-2);
}
.comment-thread {
  list-style: none;
  margin: 0 0 var(--ct-space-2);
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--ct-space-2);
}
.comment-author {
  display: block;
  border-left: 3px solid;
  padding-left: var(--ct-space-1);
  margin-bottom: 2px;
}
.replies-more {
  color: var(--ct-text-muted);
  font-size: var(--ct-text-sm);
}
.comment-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ct-space-2);
}
.comment-actions input {
  flex: 1;
  min-width: 8rem;
  font: inherit;
  padding: var(--ct-space-1) var(--ct-space-2);
  border: 1px solid var(--ct-border);
  border-radius: var(--ct-radius-sm);
  background: var(--ct-surface);
  color: var(--ct-text);
}
.card--comment {
  border-left-color: var(--ct-suggester);
  background: color-mix(in srgb, var(--ct-comment-bg) 40%, var(--ct-surface-raised));
}
.card--comment.current {
  border-color: var(--ct-border-strong);
  background: color-mix(in srgb, var(--ct-comment-bg) 55%, var(--ct-selected-bg));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ct-comment-bg) 45%, transparent);
}
.card--resolved {
  opacity: 0.6;
}
</style>
