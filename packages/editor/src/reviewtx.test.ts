import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Editor, JSONContent } from '@tiptap/core';
import { ReplaceStep } from '@tiptap/pm/transform';
import * as root from './index';
import { createManuscriptEditor } from './index';
import { applyReviewDecision, buildReviewTransaction } from './trusted';

// Synthetic sample text only.
const by = { author: 'agent:sample', ts: '2026-10-25T00:00:00Z' };
const ins = (id: string) => ({ type: 'suggestion_insert', attrs: { id, ...by } });
const del = (id: string) => ({ type: 'suggestion_delete', attrs: { id, ...by } });
const para = (content: JSONContent[]): JSONContent => ({
  type: 'paragraph',
  attrs: { style: 'body' },
  content,
});
const DOC: JSONContent = {
  type: 'doc',
  content: [
    para([{ type: 'text', text: 'Opening line.' }]),
    para([
      { type: 'text', text: 'The ' },
      { type: 'text', marks: [del('s1')], text: 'grey' },
      { type: 'text', marks: [ins('s1')], text: 'silver' },
      { type: 'text', text: ' kettle' },
      {
        type: 'footnote',
        attrs: {
          id: 'n1',
          kind: 'footnote',
          text: 'Note old new.',
          content: [
            para([
              { type: 'text', text: 'Note ' },
              { type: 'text', marks: [del('s2')], text: 'old ' },
              { type: 'text', marks: [ins('s2')], text: 'new' },
              { type: 'text', text: '.' },
            ]),
          ],
        },
      },
      { type: 'text', text: ' sang.' },
    ]),
  ],
};

let editor: Editor | undefined;
afterEach(() => editor?.destroy());
const make = () => (editor = createManuscriptEditor({ content: structuredClone(DOC) }));
const text = (e: Editor) => e.state.doc.textBetween(0, e.state.doc.content.size, '|');
const note = (e: Editor) => {
  let attrs: Record<string, unknown> | undefined;
  e.state.doc.descendants((n) => {
    if (n.type.name === 'footnote') attrs = n.attrs;
  });
  return attrs!;
};

describe('review decision transaction', () => {
  it('accepts a replacement with local steps, not a whole-document replace', () => {
    const e = make();
    const size = e.state.doc.content.size;
    const tr = buildReviewTransaction(
      e.state,
      {
        targets: [
          { kind: 'suggestion_delete', id: 's1' },
          { kind: 'suggestion_insert', id: 's1' },
        ],
        decision: 'accept',
      },
      (t) => t,
    )!;
    for (const step of tr.steps) {
      if (step instanceof ReplaceStep) {
        const s = step as unknown as { from: number; to: number };
        expect(s.to - s.from).toBeLessThan(size);
      }
    }
    expect(
      applyReviewDecision(e.view, {
        targets: [
          { kind: 'suggestion_delete', id: 's1' },
          { kind: 'suggestion_insert', id: 's1' },
        ],
        decision: 'accept',
      }),
    ).toBe(true);
    expect(text(e)).toBe('Opening line.|The silver kettle sang.');
    expect(JSON.stringify(e.getJSON())).not.toContain('"s1"');
  });

  it('is refused by the review guard without the trusted marker', () => {
    const e = make();
    const tr = buildReviewTransaction(
      e.state,
      { targets: [{ kind: 'suggestion_insert', id: 's1' }], decision: 'reject' },
      (t) => t,
    )!;
    e.view.dispatch(tr);
    expect(text(e)).toContain('silver');
  });

  it('rejects inside a footnote and recomputes attrs.text', () => {
    const e = make();
    applyReviewDecision(e.view, {
      targets: [
        { kind: 'suggestion_delete', id: 's2' },
        { kind: 'suggestion_insert', id: 's2' },
      ],
      decision: 'reject',
    });
    const a = note(e);
    expect(a.text).toBe('Note old .');
    expect(JSON.stringify(a.content)).not.toContain('s2');
    expect(text(e)).toContain('grey');
  });

  it('keeps an outside edit made after the suggestions were listed', () => {
    const e = make();
    const op = {
      targets: [
        { kind: 'suggestion_delete' as const, id: 's1' },
        { kind: 'suggestion_insert' as const, id: 's1' },
      ],
      decision: 'reject' as const,
    };
    // A collaborator types before the decision lands; positions shift.
    e.view.dispatch(e.state.tr.insertText('Early ', 1));
    let at = 0;
    e.state.doc.descendants((n, pos) => {
      if (n.isText && n.text === ' kettle') at = pos + n.nodeSize;
    });
    e.view.dispatch(e.state.tr.insertText(' small', at));
    applyReviewDecision(e.view, op);
    expect(text(e)).toBe('Early Opening line.|The grey kettle small sang.');
  });

  it('matches by (kind, attrs.id): same id of the other kind is untouched', () => {
    const e = make();
    applyReviewDecision(e.view, {
      targets: [{ kind: 'suggestion_insert', id: 's1' }],
      decision: 'accept',
    });
    expect(text(e)).toBe('Opening line.|The greysilver kettle sang.');
    expect(JSON.stringify(e.getJSON())).toContain('suggestion_delete');
  });

  it('returns false when no target is in the live doc', () => {
    const e = make();
    expect(
      applyReviewDecision(e.view, {
        targets: [{ kind: 'suggestion_insert', id: 'gone' }],
        decision: 'accept',
      }),
    ).toBe(false);
  });

  it('accepts a format_change by removing only the review mark', () => {
    const e = createManuscriptEditor({
      content: {
        type: 'doc',
        content: [
          para([
            { type: 'text', text: 'Bold ', marks: [{ type: 'bold' }] },
            { type: 'text', text: 'word.' },
          ]),
        ],
      },
    });
    editor = e;
    e.view.dispatch(
      e.state.tr.addMark(
        1,
        e.state.doc.content.size - 1,
        e.state.schema.marks.format_change!.create({
          id: 'f1',
          author: 'Kim',
          ts: '2026-10-25T00:00:00Z',
          target: 'bold',
          before: '0',
          after: '1',
        }),
      ),
    );
    applyReviewDecision(e.view, {
      targets: [{ kind: 'format_change', id: 'f1' }],
      decision: 'accept',
    });
    expect(JSON.stringify(e.getJSON())).not.toContain('f1');
    expect(e.getJSON()).toMatchObject({
      content: [{ content: [{ marks: [{ type: 'bold' }] }, { type: 'text', text: 'word.' }] }],
    });
  });

  it('rejects a format_change by restoring inline format before', () => {
    const e = createManuscriptEditor({
      content: {
        type: 'doc',
        content: [
          para([
            {
              type: 'text',
              text: 'word',
              marks: [
                { type: 'bold' },
                {
                  type: 'format_change',
                  attrs: {
                    id: 'f2',
                    author: 'Kim',
                    ts: '2026-10-25T00:00:00Z',
                    target: 'bold',
                    before: '0',
                    after: '1',
                  },
                },
              ],
            },
          ]),
        ],
      },
    });
    editor = e;
    applyReviewDecision(e.view, {
      targets: [{ kind: 'format_change', id: 'f2' }],
      decision: 'reject',
    });
    expect(JSON.stringify(e.getJSON())).not.toContain('f2');
    expect(e.getJSON()).toMatchObject({
      content: [{ content: [{ text: 'word' }] }],
    });
  });
});

// Matches any module specifier ending in /trusted or /reviewtx (optionally with an extension).
const TRUSTED_SPEC = String.raw`['"\`][^'"\`]*\/(?:trusted|reviewtx)(?:\.[cm]?[jt]sx?)?['"\`]`;
const TRUSTED_PATTERNS = [
  new RegExp(String.raw`\bfrom\s*` + TRUSTED_SPEC), // import/export ... from
  new RegExp(String.raw`\bimport\s*` + TRUSTED_SPEC), // bare side-effect import
  new RegExp(String.raw`\bimport\s*\(\s*` + TRUSTED_SPEC), // dynamic import()
  new RegExp(String.raw`\brequire\s*\(\s*` + TRUSTED_SPEC), // require()
];
function importsTrusted(src: string): boolean {
  // Drop comments so prose mentioning the module path is not flagged.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  return TRUSTED_PATTERNS.some((re) => re.test(code));
}

describe('trusted import scanner', () => {
  const planted: Record<string, string> = {
    'import from': "import { applyReviewDecision } from '@swarmdraft/editor/trusted';",
    'multiline import': "import {\n  applyReviewDecision,\n} from '../editor/src/reviewtx';",
    require: "const t = require('@swarmdraft/editor/trusted');",
    'dynamic import': "const t = await import('@swarmdraft/editor/trusted');",
    'bare import': "import '@swarmdraft/editor/trusted';",
    'export from': "export { applyReviewDecision } from '../editor/src/trusted.ts';",
    'export star': "export * from '../../packages/editor/src/trusted';",
  };
  for (const [form, src] of Object.entries(planted))
    it(`flags ${form}`, () => expect(importsTrusted(src)).toBe(true));
  it('ignores comments mentioning the path', () => {
    expect(
      importsTrusted('/** import it from `@swarmdraft/editor/trusted` */\n// require("x/trusted")'),
    ).toBe(false);
  });
  it('ignores unrelated imports', () => {
    expect(importsTrusted("import { x } from '@swarmdraft/editor';\nconst trusted = 1;")).toBe(
      false,
    );
  });
});

describe('agent path cannot reach the port', () => {
  it('is not exported from the package root', () => {
    for (const name of ['applyReviewDecision', 'buildReviewTransaction', 'allowReviewEdits'])
      expect(name in root).toBe(false);
  });

  it('only desktop review code and editor tests import trusted or reviewtx', () => {
    const repo = resolve(__dirname, '../../..');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        if (['node_modules', 'dist', 'target', '.git'].includes(f)) continue;
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|cts|mts|vue|js|mjs|cjs)$/.test(f)) {
          const src = readFileSync(p, 'utf8');
          if (importsTrusted(src)) hits.push(relative(repo, p));
        }
      }
    };
    for (const d of ['apps', 'packages', 'crates', 'mcp'].map((d) => join(repo, d)))
      try {
        walk(d);
      } catch {
        /* directory absent */
      }
    const allowed = (p: string) =>
      p.startsWith('apps/desktop/src/review/') ||
      /^packages\/editor\/src\/[^/]+\.test\.ts$/.test(p) ||
      p === 'packages/editor/src/trusted.ts';
    expect(hits.filter((h) => !allowed(h))).toEqual([]);
  });
});
