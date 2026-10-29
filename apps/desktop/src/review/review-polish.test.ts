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
import type { CommentRow, SuggestionItem } from '@coauthor/editor';

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
  it('review column scrolls as one unit (suggestions + comments)', () => {
    const css = read('ManuscriptEditor.vue');
    expect(css).toMatch(/\.manuscript-editor \.review\s*\{[^}]*overflow-y:\s*auto/s);
    expect(css).toMatch(/\.manuscript-editor \.review > :first-child\s*\{[^}]*flex:\s*none/s);
    expect(css).not.toMatch(/\.manuscript-editor \.review > :first-child\s*\{[^}]*flex:\s*1/s);
  });

  it('keeps comments below the review panel in one scrollable column', async () => {
    const by = { author: 'agent:a1', ts: '2026-10-25T00:00:00Z' };
    const chunks: JSONContent[] = Array.from({ length: 18 }, (_, i) => ({
      type: 'text',
      text: `change ${i}. `,
      marks: [{ type: 'suggestion_insert', attrs: { id: `s${i}`, ...by } }],
    }));
    chunks.push({
      type: 'text',
      marks: [{ type: 'comment_anchor', attrs: { id: 'c-last' } }],
      text: 'anchor',
    });
    const content: JSONContent = {
      type: 'doc',
      content: [{ type: 'paragraph', content: chunks }],
    };
    const commentRows: CommentRow[] = [
      {
        id: 'r1',
        threadId: 'c-last',
        body: 'Last comment body',
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
    const review = w.get('[data-test="review"]');
    const el = review.element as HTMLElement;
    const lastChild = el.lastElementChild;
    expect(lastChild?.classList.contains('comments')).toBe(true);
    expect(w.findAll('[data-test="review-item"]').length).toBe(1);
    expect(w.findAll('[data-test="item"]').length).toBe(18);
    w.unmount();
  });

  it('comment rows show the author and space before the quote', async () => {
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
    const item = w.get('[data-test="review-item"]');
    expect(item.find('[data-test="review-author"]').text()).toContain('Line Editor');
    expect(item.find('[data-test="agent-tag"]').text()).toBe('Bot');
    expect(item.find('.review-comment-head').text()).toMatch(/Comment\s*·\s*Line Editor/);
    expect(item.find('.review-comment-quote').text()).toBe('rain');
    w.unmount();
  });

  it('omits the author line on comment rows until comment rows are supplied', async () => {
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
    const item = w.get('[data-test="review-item"]');
    expect(item.find('[data-test="review-author"]').exists()).toBe(false);
    expect(item.text()).not.toContain('Unknown');
    expect(item.find('.review-comment-quote').text()).toBe('rain');
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
});
