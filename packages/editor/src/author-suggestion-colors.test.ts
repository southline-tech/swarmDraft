import { afterEach, describe, expect, it } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { AuthorSuggestionColors, createManuscriptEditor } from './index';

const by = (author: string) => ({ author, ts: '2026-10-25T00:00:00Z' });

function docWithSuggestions(
  pairs: { id: string; author: string; del: string; ins: string }[],
): JSONContent {
  const content = pairs.flatMap((p) => [
    {
      type: 'text',
      marks: [{ type: 'suggestion_delete', attrs: { id: p.id, ...by(p.author) } }],
      text: p.del,
    },
    {
      type: 'text',
      marks: [{ type: 'suggestion_insert', attrs: { id: p.id, ...by(p.author) } }],
      text: p.ins,
    },
  ]);
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The ' }, ...content] }],
  };
}

describe('AuthorSuggestionColors (#48)', () => {
  let root: HTMLElement | undefined;

  afterEach(() => {
    root?.remove();
    root = undefined;
  });

  it('sets data-suggester and --ct-suggester from two authors', () => {
    const colors = new Map([
      ['agent:a', 'var(--ct-collab-2)'],
      ['agent:b', 'var(--ct-collab-4)'],
    ]);
    root = document.createElement('div');
    const editor = createManuscriptEditor({
      element: root,
      content: docWithSuggestions([
        { id: 's1', author: 'agent:a', del: 'old', ins: 'new' },
        { id: 's2', author: 'agent:b', del: 'x', ins: 'y' },
      ]),
      extensions: [
        AuthorSuggestionColors.configure({
          colorFor: (a) => colors.get(a) ?? 'var(--ct-text-muted)',
        }),
      ],
    });

    const tokens = [...root.querySelectorAll('[data-suggester]')].map((el) =>
      (el as HTMLElement).style.getPropertyValue('--ct-suggester'),
    );
    expect(tokens).toContain('var(--ct-collab-2)');
    expect(tokens).toContain('var(--ct-collab-4)');
    expect(new Set(tokens).size).toBe(2);
    editor.destroy();
  });

  it('uses a neutral token when the author id is missing', () => {
    root = document.createElement('div');
    const editor = createManuscriptEditor({
      element: root,
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                marks: [{ type: 'suggestion_insert', attrs: { id: 'legacy', ts: 't' } }],
                text: 'orphan',
              },
            ],
          },
        ],
      },
      extensions: [
        AuthorSuggestionColors.configure({
          colorFor: (a) => (a ? 'var(--ct-collab-1)' : 'var(--ct-text-muted)'),
        }),
      ],
    });
    const el = root.querySelector('[data-suggester]') as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.style.getPropertyValue('--ct-suggester')).toBe('var(--ct-text-muted)');
    editor.destroy();
  });
});
