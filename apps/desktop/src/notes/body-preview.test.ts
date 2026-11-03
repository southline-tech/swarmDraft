import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { addNote, createNotesDoc } from './doc';
import { noteBodyPreview } from './body-preview';

describe('noteBodyPreview', () => {
  it('returns plain text from the body fragment', () => {
    const doc = createNotesDoc();
    const meta = addNote(doc, { kind: 'human', id: 'h', name: 'Author' }, 'T');
    const frag = doc.getXmlFragment(`body:${meta.id}`);
    const para = new Y.XmlElement('paragraph');
    para.insert(0, [new Y.XmlText('Hello world')]);
    frag.insert(0, [para]);
    expect(noteBodyPreview(doc, meta.id)).toBe('Hello world');
  });
});
