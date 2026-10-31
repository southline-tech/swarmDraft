import { describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { docToYDoc } from '@coauthor/docx';
import { collaborativeEditorOptions } from '../collab';
import { lintableBlockText, mapLintSpan } from './extract';
import { Spellcheck, spellIssueAtPos, spellcheckKey } from './spellcheck';
import type { SpellLintResult } from './types';

function editorWithSpell(
  content: unknown,
  lint: (text: string) => SpellLintResult[] | Promise<SpellLintResult[]>,
) {
  const ydoc = docToYDoc(content as never);
  return new Editor({
    ...collaborativeEditorOptions(ydoc, {
      extensions: [
        Spellcheck.configure({
          debounceMs: 10,
          lint: async (text) => lint(text),
        }),
      ],
    }),
    element: document.createElement('div'),
  });
}

describe('spellcheck extract', () => {
  it('skips suggestion marks when building lintable text', () => {
    const e = editorWithSpell(
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'ok ' },
              {
                type: 'text',
                text: 'bad',
                marks: [
                  {
                    type: 'suggestion_insert',
                    attrs: { id: 's1', author: 'a', ts: '2026-10-25T00:00:00Z' },
                  },
                ],
              },
            ],
          },
        ],
      },
      () => [],
    );
    const block = e.state.doc.firstChild!;
    const { text } = lintableBlockText(block, 0);
    expect(text).toBe('ok ');
    e.destroy();
  });

  it('maps lint offsets back to document positions', () => {
    const map = [5, 6, 7];
    expect(mapLintSpan(map, 0, 2)).toEqual({ from: 5, to: 7 });
  });
});

describe('spellcheck decorations', () => {
  it('draws decorations for returned lints without changing the doc', () => {
    const e = editorWithSpell(
      {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'tst word' }] }],
      },
      (text) => {
        const idx = text.indexOf('tst');
        if (idx < 0) return [];
        return [
          {
            start: idx,
            end: idx + 3,
            kind: 'spelling',
            message: 'Misspelled',
            suggestions: ['test'],
          },
        ];
      },
    );
    return new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        try {
          const issue = spellIssueAtPos(e.state, 1);
          expect(issue?.kind).toBe('spelling');
          const decos = spellcheckKey.getState(e.state)?.decorations;
          expect(decos && decos.find().length).toBeGreaterThan(0);
          expect(e.state.doc.textContent).toBe('tst word');
          e.destroy();
          resolve();
        } catch (err) {
          e.destroy();
          reject(err);
        }
      }, 40);
    });
  });

  it('debounces lint after rapid edits', async () => {
    const lint = vi.fn(async (): Promise<SpellLintResult[]> => []);
    const e = editorWithSpell(
      {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
      },
      lint,
    );
    const before = lint.mock.calls.length;
    e.commands.insertContent('!');
    e.commands.insertContent('?');
    await new Promise((r) => setTimeout(r, 50));
    const afterBurst = lint.mock.calls.length;
    expect(afterBurst).toBeGreaterThan(before);
    await new Promise((r) => setTimeout(r, 30));
    expect(lint.mock.calls.length).toBe(afterBurst);
    e.destroy();
  });
});
