import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import type { CommentRow } from '@swarmdraft/editor';
import ManuscriptEditor from '../ManuscriptEditor.vue';
import { loadProfile } from '../settings/prefs';

vi.mock('../backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend')>();
  return {
    ...actual,
    sectionCommentReply: vi.fn(async () => ({
      id: 'c-reply',
      threadId: 'sample-c1',
      body: 'Noted.',
      authorKind: 'human',
      authorId: 'local',
      authorName: 'Mara',
      createdAt: '2026-11-01T00:00:00Z',
      resolvedAt: null,
    })),
    sectionCommentResolve: vi.fn(async () => {}),
    sectionReviewMeta: vi.fn(async () => ({
      comments: [
        {
          id: 'r1',
          threadId: 'sample-c1',
          body: 'Wet.',
          authorKind: 'human',
          authorId: 'u',
          authorName: 'Mara',
          createdAt: '2026-10-26T00:00:00Z',
          resolvedAt: null,
        },
        {
          id: 'c-reply',
          threadId: 'sample-c1',
          body: 'Noted.',
          authorKind: 'human',
          authorId: 'local',
          authorName: 'Mara',
          createdAt: '2026-11-01T00:00:00Z',
          resolvedAt: null,
        },
      ],
      authorSavedNames: {},
      suggestionReasons: {},
    })),
  };
});

import { sectionCommentReply, sectionCommentResolve, sectionReviewMeta } from '../backend';

const SAMPLE_DOC = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          marks: [{ type: 'comment_anchor', attrs: { id: 'sample-c1' } }],
          text: 'rain',
        },
      ],
    },
  ],
};

const Harness = defineComponent({
  components: { ManuscriptEditor },
  setup() {
    const commentRows = ref<CommentRow[]>([
      {
        id: 'r1',
        threadId: 'sample-c1',
        body: 'Wet.',
        authorKind: 'human',
        authorId: 'u',
        authorName: 'Mara',
        createdAt: '2026-10-26T00:00:00Z',
      },
    ]);
    async function onCommentReply(threadId: string, body: string) {
      const profile = loadProfile();
      await sectionCommentReply('m1', 'sec1', threadId, body, profile.name, 'local');
      const meta = await sectionReviewMeta('sec1');
      commentRows.value = meta.comments;
    }
    async function onCommentResolve(threadId: string, resolved: boolean) {
      await sectionCommentResolve('m1', 'sec1', threadId, resolved);
      const meta = await sectionReviewMeta('sec1');
      commentRows.value = meta.comments;
    }
    return { commentRows, onCommentReply, onCommentResolve, SAMPLE_DOC };
  },
  template: `
    <ManuscriptEditor
      :content="SAMPLE_DOC"
      section-id="sec1"
      :comment-rows="commentRows"
      review-target="#review-rail"
      @comment-reply="onCommentReply"
      @comment-resolve="onCommentResolve"
    />
    <div id="review-rail" />
  `,
});

describe('comment reply and resolve persistence (#255)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('reply from review card invokes storage IPC and reloads rows', async () => {
    const w = mount(Harness, { attachTo: document.body });
    await flushPromises();
    const input = w.get('[data-test="reply-input"]');
    await input.setValue('Noted.');
    await w.get('[data-test="reply"]').trigger('click');
    await flushPromises();
    expect(sectionCommentReply).toHaveBeenCalledWith(
      'm1',
      'sec1',
      'sample-c1',
      'Noted.',
      expect.any(String),
      'local',
    );
    expect(sectionReviewMeta).toHaveBeenCalledWith('sec1');
    expect(w.findAll('[data-test="comment-body"]')).toHaveLength(2);
    w.unmount();
  });

  it('resolve invokes storage IPC with resolved flag', async () => {
    const w = mount(Harness, { attachTo: document.body });
    await flushPromises();
    await w.get('[data-test="resolve"]').trigger('click');
    await flushPromises();
    expect(sectionCommentResolve).toHaveBeenCalledWith('m1', 'sec1', 'sample-c1', true);
    expect(sectionReviewMeta).toHaveBeenCalledWith('sec1');
    w.unmount();
  });
});
