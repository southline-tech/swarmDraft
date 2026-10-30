import { afterEach, describe, expect, it } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { AuthorSuggestionColors, createManuscriptEditor, refreshSuggestionColors } from './index';

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

  it('sets data-suggester and per-author paint tokens from two authors', () => {
    const sheet = document.createElement('style');
    sheet.textContent = `
      :root { --ct-text: #111; --ct-text-muted: #666; --ct-collab-1: #2f5da8; --ct-collab-2: #a1452a; --ct-collab-4: #7a4bb0; }
      :where([data-suggester]) {
        --ct-suggest-insert-bg: color-mix(in srgb, var(--ct-suggester) 14%, transparent);
        --ct-suggest-insert-underline: var(--ct-suggester);
        --ct-suggest-delete-strike: var(--ct-suggester);
      }
      ins.suggestion-insert [data-suggester] {
        background: var(--ct-suggest-insert-bg);
      }
    `;
    document.head.appendChild(sheet);
    const colors = new Map([
      ['agent:a', 'var(--ct-collab-2)'],
      ['agent:b', 'var(--ct-collab-4)'],
    ]);
    root = document.createElement('div');
    document.body.appendChild(root);
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

    const insertDecos = [...root.querySelectorAll('ins.suggestion-insert [data-suggester]')];
    expect(insertDecos.length).toBeGreaterThanOrEqual(2);
    const tokens = insertDecos.map((el) =>
      (el as HTMLElement).style.getPropertyValue('--ct-suggester'),
    );
    expect(tokens).toContain('var(--ct-collab-2)');
    expect(tokens).toContain('var(--ct-collab-4)');
    const polluted = document.createElement('div');
    polluted.setAttribute('data-suggester', '');
    polluted.style.setProperty('--ct-suggester', 'var(--ct-collab-1)');
    root!.prepend(polluted);
    const painted = insertDecos.map((el) =>
      getComputedStyle(el as HTMLElement)
        .getPropertyValue('--ct-suggest-insert-underline')
        .trim(),
    );
    expect(new Set(painted).size).toBe(2);
    expect(new Set(painted)).toEqual(new Set(['#a1452a', '#7a4bb0']));
    const decos = [
      ...root.querySelectorAll(
        'ins.suggestion-insert [data-suggester], del.suggestion-delete [data-suggester]',
      ),
    ];
    expect(decos.map((el) => (el as HTMLElement).style.getPropertyValue('--ct-suggester'))).toEqual(
      expect.arrayContaining(tokens),
    );
    sheet.remove();
    editor.destroy();
    root.remove();
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

  it('hides paint decorations for filtered-out authors (#50)', () => {
    root = document.createElement('div');
    document.body.appendChild(root);
    let visible = new Set(['agent:a']);
    const editor = createManuscriptEditor({
      element: root,
      content: docWithSuggestions([
        { id: 's1', author: 'agent:a', del: 'old', ins: 'new' },
        { id: 's2', author: 'agent:b', del: 'x', ins: 'y' },
      ]),
      extensions: [
        AuthorSuggestionColors.configure({
          colorFor: () => 'var(--ct-collab-1)',
          authorVisible: (a) => visible.has(a),
        }),
      ],
    });
    const suggesterCount = () => root!.querySelectorAll('[data-suggester]').length;
    const hiddenCount = () => root!.querySelectorAll('.suggestion-filter-hidden').length;
    expect(suggesterCount()).toBe(2);
    expect(hiddenCount()).toBe(2);
    visible = new Set(['agent:a', 'agent:b']);
    refreshSuggestionColors(editor.view);
    expect(suggesterCount()).toBe(4);
    expect(hiddenCount()).toBe(0);
    editor.destroy();
    root.remove();
  });

  it('shows mixed-author text when any author is visible (#50)', () => {
    root = document.createElement('div');
    document.body.appendChild(root);
    const visible = new Set(['agent:b']);
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
                marks: [
                  { type: 'suggestion_insert', attrs: { id: 'x1', ...by('agent:a') } },
                  { type: 'suggestion_delete', attrs: { id: 'y1', ...by('agent:b') } },
                ],
                text: 'bright',
              },
            ],
          },
        ],
      },
      extensions: [
        AuthorSuggestionColors.configure({
          colorFor: (a) => (a ? 'var(--ct-collab-1)' : 'var(--ct-text-muted)'),
          authorVisible: (a) => visible.has(a),
        }),
      ],
    });
    expect(root!.querySelector('.suggestion-filter-hidden')).toBeNull();
    const el = root!.querySelector('[data-suggester]') as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.style.getPropertyValue('--ct-suggester')).toBe('var(--ct-text-muted)');
    editor.destroy();
    root.remove();
  });
});
