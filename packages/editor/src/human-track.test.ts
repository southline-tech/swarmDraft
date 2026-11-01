import { afterEach, describe, expect, it } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import {
  docToYDoc,
  exportDocx,
  importDocx,
  yDocToDoc,
  type ImportedManuscript,
} from '@swarmdraft/docx';
import type { DocNode } from '@swarmdraft/schema';
import {
  HumanTrackChanges,
  listSuggestions,
  manuscriptEditorOptions,
  collaborativeEditorOptions,
} from './index';
import { applyReviewDecision } from './trusted';

const WRITER = 'Rowan Vale';
const plainDoc: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: { style: 'body' },
      content: [{ type: 'text', text: 'Alpha line.' }],
    },
  ],
};

const styledDoc: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: { style: 'body' },
      content: [
        { type: 'text', text: 'See ' },
        { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' word.' },
      ],
    },
  ],
};

const twoParaDoc: JSONContent = {
  type: 'doc',
  content: [
    { type: 'paragraph', attrs: { style: 'body' }, content: [{ type: 'text', text: 'First.' }] },
    { type: 'paragraph', attrs: { style: 'body' }, content: [{ type: 'text', text: 'Second.' }] },
  ],
};

function editor(content: JSONContent = plainDoc, tracking = true) {
  return new Editor(
    manuscriptEditorOptions({
      element: document.createElement('div'),
      content,
      extensions: [
        HumanTrackChanges.configure({
          active: () => tracking,
          author: () => WRITER,
        }),
      ],
    }),
  );
}

const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((e) => e.destroy()));

function manuscriptFromDoc(doc: DocNode): ImportedManuscript {
  return {
    title: 'Fixture',
    sections: [
      {
        id: 'ch1',
        kind: 'chapter',
        title: 'Chapter',
        docId: 'm:ch1',
        content: doc,
      },
    ],
    comments: [],
    report: {
      items: [],
      summary: {
        frontMatter: 0,
        parts: 0,
        chapters: 1,
        scenes: 0,
        sceneBreaks: 0,
        backMatter: 0,
        footnotes: 0,
        comments: 0,
        suggestions: 0,
        paragraphs: 1,
      },
    },
    warnings: [],
  };
}

describe('human track changes (#126)', () => {
  it('records an insert as a suggestion under the writer name', () => {
    const e = editor();
    editors.push(e);
    const pos = e.state.doc.content.size - 1;
    e.view.dispatch(e.state.tr.insertText(' More', pos));
    const items = listSuggestions(e.getJSON() as never);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'suggestion_insert',
      author: WRITER,
      text: ' More',
    });
    expect(e.state.doc.textContent).toContain(' More');
    e.destroy();
  });

  it('merges continuous typing into one suggestion id', () => {
    const e = editor();
    editors.push(e);
    for (const ch of 'hello') {
      e.view.dispatch(e.state.tr.insertText(ch, e.state.doc.content.size - 1));
    }
    const items = listSuggestions(e.getJSON() as never).filter(
      (i) => i.kind === 'suggestion_insert',
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe('hello');
    expect(new Set(items.map((i) => i.id)).size).toBe(1);
    e.destroy();
  });

  it('does not share human track state across editors', () => {
    const eOn = editor(plainDoc, true);
    const eOff = editor(plainDoc, false);
    editors.push(eOn, eOff);
    for (const ch of 'hi') {
      eOn.view.dispatch(eOn.state.tr.insertText(ch, eOn.state.doc.content.size - 1));
    }
    expect(
      listSuggestions(eOn.getJSON() as never).filter((i) => i.kind === 'suggestion_insert'),
    ).toEqual([expect.objectContaining({ text: 'hi' })]);
    eOff.view.dispatch(eOff.state.tr.insertText('x', eOff.state.doc.content.size - 1));
    expect(listSuggestions(eOff.getJSON() as never)).toHaveLength(0);
    eOn.destroy();
    eOff.destroy();
  });

  it('records paragraph split (Enter) as a tracked insert (#182)', () => {
    const e = editor();
    editors.push(e);
    e.commands.setTextSelection(6);
    e.commands.splitBlock();
    const items = listSuggestions(e.getJSON() as never).filter(
      (i) => i.kind === 'suggestion_insert' && i.author === WRITER,
    );
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.text.includes('line.'))).toBe(true);
    e.destroy();
  });

  it('records Enter at end of paragraph as a tracked change (#182)', () => {
    const e = editor();
    editors.push(e);
    e.commands.setTextSelection(e.state.doc.content.size - 1);
    e.commands.splitBlock();
    const items = listSuggestions(e.getJSON() as never).filter((i) => i.author === WRITER);
    expect(items.length).toBeGreaterThan(0);
    expect(e.state.doc.textContent).not.toContain('\u200b');
    e.destroy();
  });

  it('rejecting Enter mid-paragraph restores a single paragraph (#182)', () => {
    const e = editor();
    editors.push(e);
    e.commands.setTextSelection(6);
    e.commands.splitBlock();
    expect(e.state.doc.childCount).toBe(2);
    let hasBlockSplit = false;
    e.state.doc.descendants((node) => {
      if (!node.isText) return;
      for (const m of node.marks) {
        if (m.type.name === 'suggestion_insert' && m.attrs.blockSplit === true)
          hasBlockSplit = true;
      }
    });
    expect(hasBlockSplit).toBe(true);
    const items = listSuggestions(e.getJSON() as never).filter(
      (i) => i.kind === 'suggestion_insert' && i.author === WRITER,
    );
    expect(items.length).toBeGreaterThan(0);
    applyReviewDecision(e.view, {
      targets: items.map((i) => ({ kind: i.kind, id: i.id })),
      decision: 'reject',
    });
    expect(e.state.doc.childCount).toBe(1);
    expect(e.state.doc.textContent).toBe('Alpha line.');
    e.destroy();
  });

  it('accepting Enter at end leaves no U+200B (#182)', () => {
    const e = editor();
    editors.push(e);
    e.commands.setTextSelection(e.state.doc.content.size - 1);
    e.commands.splitBlock();
    const items = listSuggestions(e.getJSON() as never).filter((i) => i.author === WRITER);
    applyReviewDecision(e.view, {
      targets: items.map((i) => ({ kind: i.kind, id: i.id })),
      decision: 'accept',
    });
    expect(e.state.doc.textContent).not.toContain('\u200b');
    expect(e.state.doc.childCount).toBe(2);
    e.destroy();
  });

  it('marks duplicated short tail text on the new block after split (#182)', () => {
    const dupDoc: JSONContent = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { style: 'body' }, content: [{ type: 'text', text: 'aa' }] },
        { type: 'paragraph', attrs: { style: 'body' }, content: [{ type: 'text', text: 'aa' }] },
      ],
    };
    const e = editor(dupDoc);
    editors.push(e);
    let secondParaPos = 0;
    e.state.doc.forEach((_node, _offset, index) => {
      if (index === 1) {
        let pos = 0;
        for (let i = 0; i < index; i++) pos += e.state.doc.child(i).nodeSize;
        secondParaPos = pos + 1 + 1;
      }
    });
    e.commands.setTextSelection(secondParaPos);
    e.commands.splitBlock();
    expect(e.state.doc.childCount).toBe(3);
    const insId = listSuggestions(e.getJSON() as never).find(
      (i) => i.kind === 'suggestion_insert' && i.author === WRITER,
    )!.id;
    let markedBlock = -1;
    e.state.doc.forEach((block, _offset, index) => {
      block.descendants((node) => {
        if (!node.isText) return;
        if (
          node.marks.some(
            (m) => m.type.name === 'suggestion_insert' && String(m.attrs.id) === insId,
          )
        ) {
          markedBlock = index;
        }
      });
    });
    expect(markedBlock).toBe(2);
    e.destroy();
  });

  it('records a delete as suggestion_delete without removing text', () => {
    const e = editor();
    editors.push(e);
    e.commands.setTextSelection({ from: 1, to: 6 });
    e.view.dispatch(e.state.tr.deleteSelection());
    const items = listSuggestions(e.getJSON() as never);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'suggestion_delete', author: WRITER, text: 'Alpha' });
    expect(e.state.doc.textContent).toBe('Alpha line.');
    e.destroy();
  });

  it('removes own pending insert instead of striking it', () => {
    const e = editor();
    editors.push(e);
    const at = e.state.doc.content.size - 1;
    e.view.dispatch(e.state.tr.insertText('note', at));
    expect(listSuggestions(e.getJSON() as never)).toHaveLength(1);
    const insId = listSuggestions(e.getJSON() as never)[0]!.id;
    let delFrom = 0;
    let delTo = 0;
    e.state.doc.descendants((node, pos) => {
      if (!node.isText) return;
      if (
        !node.marks.some((m) => m.type.name === 'suggestion_insert' && String(m.attrs.id) === insId)
      ) {
        return;
      }
      delFrom = pos;
      delTo = pos + node.text!.length;
    });
    expect(delTo).toBeGreaterThan(delFrom);
    expect(e.state.doc.textBetween(delFrom, delTo)).toBe('note');
    e.view.dispatch(e.state.tr.delete(delFrom, delTo));
    expect(listSuggestions(e.getJSON() as never)).toHaveLength(0);
    expect(e.state.doc.textContent).not.toContain('note');
    e.destroy();
  });

  it('preserves inline marks on a tracked delete', () => {
    const e = editor(styledDoc);
    editors.push(e);
    e.commands.setTextSelection({ from: 5, to: 9 });
    e.view.dispatch(e.state.tr.deleteSelection());
    const json = e.getJSON() as DocNode;
    const para = json.content[0];
    expect(para?.type).toBe('paragraph');
    const inlines = para && para.type === 'paragraph' ? (para.content ?? []) : [];
    const bold = inlines.find((n) => n.type === 'text' && n.text === 'bold');
    expect(
      bold && bold.type === 'text' && bold.marks?.some((m) => m.type === 'suggestion_delete'),
    ).toBe(true);
    expect(bold && bold.type === 'text' && bold.marks?.some((m) => m.type === 'bold')).toBe(true);
    e.destroy();
  });

  it('marks every inserted run in a multi-paragraph paste (#163)', () => {
    const e = editor();
    editors.push(e);
    const pos = e.state.doc.content.size - 1;
    e.commands.insertContentAt(pos, [
      {
        type: 'paragraph',
        attrs: { style: 'body' },
        content: [{ type: 'text', text: 'Para A.' }],
      },
      {
        type: 'paragraph',
        attrs: { style: 'body' },
        content: [{ type: 'text', text: 'Para B.' }],
      },
    ]);
    expect(e.state.doc.textContent).toContain('Para B.');
    const inserts = listSuggestions(e.getJSON() as never).filter(
      (i) => i.kind === 'suggestion_insert' && i.author === WRITER,
    );
    expect(inserts.some((i) => i.text.includes('Para A'))).toBe(true);
    expect(inserts.some((i) => i.text.includes('Para B'))).toBe(true);
    expect(new Set(inserts.map((i) => i.id)).size).toBe(1);
    e.destroy();
  });

  it('preserves paragraph structure on a cross-paragraph delete', () => {
    const e = editor(twoParaDoc);
    editors.push(e);
    const firstEnd = e.state.doc.child(0).nodeSize + 1;
    const secondStart = firstEnd + 1;
    e.commands.setTextSelection({ from: firstEnd - 2, to: secondStart + 3 });
    e.view.dispatch(e.state.tr.deleteSelection());
    expect((e.getJSON() as DocNode).content).toHaveLength(2);
    const delText = listSuggestions(e.getJSON() as never)
      .filter((i) => i.kind === 'suggestion_delete')
      .map((i) => i.text)
      .join('');
    expect(delText.length).toBeGreaterThan(2);
    e.destroy();
  });

  it('records replace as paired marks sharing an id after an earlier delete', () => {
    const e = editor();
    editors.push(e);
    e.commands.setTextSelection({ from: 7, to: 12 });
    e.view.dispatch(e.state.tr.deleteSelection());
    e.commands.setTextSelection({ from: 1, to: 6 });
    e.view.dispatch(e.state.tr.insertText('Howdy'));
    const items = listSuggestions(e.getJSON() as never).filter((i) => i.author === WRITER);
    const howdy = items.find((i) => i.kind === 'suggestion_insert' && i.text === 'Howdy');
    expect(howdy).toBeDefined();
    expect(items.some((i) => i.kind === 'suggestion_delete' && i.id === howdy!.id)).toBe(true);
    e.destroy();
  });

  it('records replace as paired marks sharing an id', () => {
    const e = editor();
    editors.push(e);
    e.commands.setTextSelection({ from: 1, to: 6 });
    e.view.dispatch(e.state.tr.insertText('Beta'));
    const items = listSuggestions(e.getJSON() as never);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.id)).toEqual([items[0]!.id, items[0]!.id]);
    expect(items.find((i) => i.kind === 'suggestion_delete')?.text).toBe('Alpha');
    expect(items.find((i) => i.kind === 'suggestion_insert')?.text).toBe('Beta');
    e.destroy();
  });

  it('does not track when the toggle is off', () => {
    const e = editor(plainDoc, false);
    editors.push(e);
    e.view.dispatch(e.state.tr.insertText('x', e.state.doc.content.size - 1));
    expect(listSuggestions(e.getJSON() as never)).toHaveLength(0);
    e.destroy();
  });

  it('undo removes a tracked insert', () => {
    const ydoc = docToYDoc(plainDoc as never);
    const e = new Editor(
      collaborativeEditorOptions(ydoc, {
        element: document.createElement('div'),
        extensions: [HumanTrackChanges.configure({ active: () => true, author: () => WRITER })],
      }),
    );
    editors.push(e);
    e.view.dispatch(e.state.tr.insertText(' tail', e.state.doc.content.size - 1));
    expect(listSuggestions(e.getJSON() as never)).toHaveLength(1);
    expect(e.commands.undo()).toBe(true);
    expect(listSuggestions(e.getJSON() as never)).toHaveLength(0);
    expect(e.state.doc.textContent).not.toContain(' tail');
    e.destroy();
  });

  it('persists suggestions through Yjs round-trip', () => {
    const ydoc = docToYDoc(plainDoc as never);
    const e = new Editor(
      collaborativeEditorOptions(ydoc, {
        element: document.createElement('div'),
        extensions: [HumanTrackChanges.configure({ active: () => true, author: () => WRITER })],
      }),
    );
    editors.push(e);
    e.view.dispatch(e.state.tr.insertText('!', 1));
    const exported = yDocToDoc(ydoc);
    expect(listSuggestions(exported).some((s) => s.author === WRITER)).toBe(true);
    e.destroy();
  });

  it('exports human suggestion_insert in docx', () => {
    const e = editor();
    editors.push(e);
    e.view.dispatch(e.state.tr.insertText(' export', e.state.doc.content.size - 1));
    const doc = e.getJSON() as DocNode;
    const bytes = exportDocx(manuscriptFromDoc(doc));
    const back = importDocx(bytes);
    const human = listSuggestions(back.sections[0]!.content as never).filter(
      (s) => s.author === WRITER,
    );
    expect(human.some((s) => s.kind === 'suggestion_insert' && s.text.includes('export'))).toBe(
      true,
    );
    e.destroy();
  });
});

describe('human track trusted marks', () => {
  it('dispatches a trusted append pass after recording', () => {
    const e = editor();
    editors.push(e);
    e.view.dispatch(e.state.tr.insertText('z', 1));
    expect(listSuggestions(e.getJSON() as never)).toHaveLength(1);
    e.destroy();
  });
});
