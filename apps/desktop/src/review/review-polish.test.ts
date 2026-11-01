import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { JSONContent } from '@tiptap/core';
import ManuscriptEditor from '../ManuscriptEditor.vue';
import { REMOVED_NOTE, markAuthorLabel, setAgents } from '../agent-names';
import ReviewPanel from './ReviewPanel.vue';
import type { Agent } from '../backend';
import type { CommentRow, SuggestionItem } from '@swarmdraft/editor';
import { buildReviewList, commentReviewKey } from './review-inline';
import type { ReviewChange } from './review-state';

const agent = (id: string, name: string): Agent => ({
  id,
  name,
  color: '#3366ff',
  createdAt: '2026-10-26T00:00:00Z',
  revokedAt: null,
  primary: false,
});

const read = (p: string) =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', p), 'utf8');

describe('review sidebar polish (#47)', () => {
  it('review column scrolls as one unit through ReviewPanel only (#239)', () => {
    const css = read('ManuscriptEditor.vue');
    expect(css).toMatch(/\.manuscript-editor \.review\s*\{[^}]*overflow-y:\s*auto/s);
    expect(css).not.toMatch(/class="comments"/);
  });

  it('interleaves comments with suggestions in document order in one list', async () => {
    const by = { author: 'agent:a1', ts: '2026-10-25T00:00:00Z' };
    const content: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              marks: [{ type: 'suggestion_insert', attrs: { id: 's0', ...by } }],
              text: 'first ',
            },
            {
              type: 'text',
              marks: [{ type: 'comment_anchor', attrs: { id: 'c-mid' } }],
              text: 'mid',
            },
            {
              type: 'text',
              marks: [{ type: 'suggestion_insert', attrs: { id: 's1', ...by } }],
              text: ' last',
            },
          ],
        },
      ],
    };
    const commentRows: CommentRow[] = [
      {
        id: 'r1',
        threadId: 'c-mid',
        body: 'Middle note',
        authorKind: 'human',
        authorId: 'me',
        authorName: 'Mara',
        createdAt: '2026-10-26T00:00:00Z',
      },
    ];
    setAgents([agent('a1', 'Draft Helper')]);
    const w = mount(ManuscriptEditor, {
      props: { content, commentRows },
      attachTo: document.body,
    });
    await flushPromises();
    const rows = w.findAll('[data-kind]');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.attributes('data-kind'))).toEqual([
      'suggestion',
      'comment',
      'suggestion',
    ]);
    expect(w.find('.comments').exists()).toBe(false);
    w.unmount();
  });

  it('comment cards show author, Comment pill, and quote on comment background', async () => {
    const content: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              marks: [{ type: 'comment_anchor', attrs: { id: 'c1' } }],
              text: 'rain',
            },
          ],
        },
      ],
    };
    const commentRows: CommentRow[] = [
      {
        id: 'r1',
        threadId: 'c1',
        body: 'Wet.',
        authorKind: 'agent',
        authorId: 'a1',
        authorName: 'agent:a1',
        createdAt: '2026-10-26T00:00:00Z',
      },
    ];
    setAgents([agent('a1', 'Line Editor')]);
    const w = mount(ManuscriptEditor, {
      props: { content, commentRows },
      attachTo: document.body,
    });
    await flushPromises();
    const item = w.get('[data-kind="comment"]');
    expect(item.text()).toContain('Line Editor');
    expect(item.text()).toContain('Comment');
    expect(item.find('[data-test="comment-quote"]').text()).toBe('rain');
    w.unmount();
  });

  it('selects comment rows with aria-selected and keeps focus (#211 / review)', async () => {
    const content: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              marks: [{ type: 'comment_anchor', attrs: { id: 'c1' } }],
              text: 'rain',
            },
          ],
        },
      ],
    };
    const commentRows: CommentRow[] = [
      {
        id: 'r1',
        threadId: 'c1',
        body: 'Wet.',
        authorKind: 'human',
        authorId: 'u',
        authorName: 'Mara',
        createdAt: '2026-10-26T00:00:00Z',
      },
    ];
    const w = mount(ManuscriptEditor, { props: { content, commentRows }, attachTo: document.body });
    await flushPromises();
    const row = w.get('[data-kind="comment"]');
    await row.trigger('click');
    await flushPromises();
    expect(row.attributes('aria-selected')).toBe('true');
    expect(row.classes()).toContain('current');
    w.unmount();
  });

  it('shows quote without author line when comment rows are not supplied yet', async () => {
    const content: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              marks: [{ type: 'comment_anchor', attrs: { id: 'c1' } }],
              text: 'rain',
            },
          ],
        },
      ],
    };
    const w = mount(ManuscriptEditor, { props: { content }, attachTo: document.body });
    await flushPromises();
    expect(w.find('[data-test="review-item"][data-kind="comment"]').exists()).toBe(false);
    w.unmount();
  });

  it('deleted agents show saved name and muted (removed) in the review panel', () => {
    const items: SuggestionItem[] = [
      { id: 's1', kind: 'suggestion_insert', author: 'agent:gone', ts: 't', text: 'x' },
    ];
    setAgents([]);
    const w = mount(ReviewPanel, {
      props: {
        items,
        listItems: [
          {
            kind: 'suggestion',
            key: 'agent:gone\u0000s1',
            from: 0,
            change: {
              key: 'agent:gone\u0000s1',
              id: 's1',
              author: 'agent:gone',
              ins: 'x',
              targets: [{ kind: 'suggestion_insert', id: 's1' }],
            },
          },
        ],
        labels: (a: string) => markAuthorLabel(a, { 'agent:gone': 'Old Name' }),
      },
    });
    const who = w.find('[data-test=item] .who');
    expect(who.find('[data-test=agent-name]').text()).toBe('Old Name');
    expect(who.find('[data-test=agent-note]').text()).toBe(REMOVED_NOTE);
    w.unmount();
  });

  it('ManuscriptEditor merges authorSavedNames into review cards', async () => {
    const content: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              marks: [
                { type: 'suggestion_insert', attrs: { id: 's1', author: 'agent:gone', ts: 't' } },
              ],
              text: 'x',
            },
          ],
        },
      ],
    };
    setAgents([]);
    const w = mount(ManuscriptEditor, {
      props: {
        content,
        authorLabels: markAuthorLabel,
        authorSavedNames: { 'agent:gone': 'Old Name' },
      },
      attachTo: document.body,
    });
    await flushPromises();
    const who = w.find('[data-test=item] .who');
    expect(who.find('[data-test=agent-name]').text()).toBe('Old Name');
    expect(who.find('[data-test=agent-note]').text()).toBe(REMOVED_NOTE);
    w.unmount();
  });

  it('shows bot rationale on review cards through the editor (#60)', async () => {
    const content: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              marks: [
                {
                  type: 'suggestion_insert',
                  attrs: { id: 's1', author: 'agent:a1', ts: 't' },
                },
              ],
              text: 'guttered',
            },
          ],
        },
      ],
    };
    setAgents([agent('a1', 'Draft Helper')]);
    const w = mount(ManuscriptEditor, {
      props: { content, suggestionReasons: { s1: 'Stronger verb.' } },
      attachTo: document.body,
    });
    await flushPromises();
    expect(w.get('[data-test=reason-line]').text()).toContain('Stronger verb.');
    const card = w.get('[data-test=item]').element;
    expect(card.querySelector('.who')?.nextElementSibling?.classList.contains('q')).toBe(true);
    expect(card.querySelector('.q')?.nextElementSibling?.classList.contains('reason')).toBe(true);
    w.unmount();
  });

  it('shows one margin note per bot replace suggestion (#189)', async () => {
    const by = { author: 'agent:a1', ts: '2026-10-25T00:00:00Z' };
    const content: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'The light ' },
            {
              type: 'text',
              text: 'flickered',
              marks: [{ type: 'suggestion_delete', attrs: { id: 's1', ...by } }],
            },
            {
              type: 'text',
              text: 'guttered',
              marks: [{ type: 'suggestion_insert', attrs: { id: 's1', ...by } }],
            },
            { type: 'text', text: ' out.' },
          ],
        },
      ],
    };
    setAgents([agent('a1', 'Draft Helper')]);
    const w = mount(ManuscriptEditor, { props: { content }, attachTo: document.body });
    await flushPromises();
    expect(w.findAll('[data-test="margin-note"]')).toHaveLength(1);
    w.unmount();
  });
});

describe('buildReviewList author filter (#239)', () => {
  it('keeps comments visible when filtering suggestions', () => {
    const list = buildReviewList({
      changes: [
        {
          key: 'agent:a1\u0000s1',
          id: 's1',
          author: 'agent:a1',
          ins: 'x',
          targets: [{ kind: 'suggestion_insert', id: 's1' }],
        } satisfies ReviewChange,
      ],
      threads: [
        {
          id: 'c1',
          anchorText: 'q',
          order: 0,
          comments: [
            {
              id: 'r1',
              threadId: 'c1',
              body: 'b',
              authorKind: 'human',
              authorId: 'u',
              authorName: 'M',
              createdAt: '2026-01-01T00:00:00Z',
            },
          ],
          resolved: false,
          orphan: 'none',
        },
      ],
      filter: 'agent:other',
      showResolved: false,
      fromOfChange: () => 0,
      fromOfThread: () => 1,
    });
    expect(list).toHaveLength(1);
    expect(list[0]!.kind).toBe('comment');
    expect(list[0]!.key).toBe(commentReviewKey('c1'));
  });
});
