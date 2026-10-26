import type { JSONContent } from '@tiptap/core';

/** Synthetic placeholder shown until manuscripts load from disk (RAD-203). */
const by = { author: 'agent:sample', ts: '2026-10-25T00:00:00Z' };
export const SAMPLE_DOC: JSONContent = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Chapter One' }] },
    {
      type: 'paragraph',
      attrs: { style: 'first' },
      content: [
        { type: 'text', text: 'The lantern ' },
        {
          type: 'text',
          marks: [{ type: 'suggestion_delete', attrs: { id: 'sample-s1', ...by } }],
          text: 'flickered',
        },
        {
          type: 'text',
          marks: [{ type: 'suggestion_insert', attrs: { id: 'sample-s1', ...by } }],
          text: 'guttered',
        },
        { type: 'text', text: ' twice before the ' },
        {
          type: 'text',
          marks: [{ type: 'comment_anchor', attrs: { id: 'sample-c1' } }],
          text: 'rain',
        },
        { type: 'text', text: ' began.' },
      ],
    },
    { type: 'scene_break', attrs: { marker: '***' } },
    {
      type: 'paragraph',
      attrs: { style: 'first' },
      content: [{ type: 'text', text: 'Morning came late.' }],
    },
  ],
};
