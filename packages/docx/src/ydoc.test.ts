import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { markKey } from '@coauthor/schema';
import { FRAGMENT_NAME, docToYDoc, rekeyMarks, yDocToDoc } from './ydoc';

const by = { author: 'agent:fixture', ts: '2026-01-01T00:00:00Z' };

function legacyDoc(): Y.Doc {
  // As written by RAD-218 (#5): review marks keyed `type--id`.
  const ydoc = new Y.Doc();
  ydoc.transact(() => {
    const p = new Y.XmlElement('paragraph');
    ydoc.getXmlFragment(FRAGMENT_NAME).insert(0, [p]);
    p.setAttribute('style', 'body');
    const t = new Y.XmlText();
    p.insert(0, [t]);
    t.insert(0, 'plain ');
    t.insert(6, 'both', { 'comment_anchor--c1': { id: 'c1' }, italic: {} });
    t.insert(10, ' new', { 'suggestion_insert--s1': { id: 's1', ...by } });
  });
  return ydoc;
}

describe('rekeyMarks', () => {
  it('re-keys legacy type--id keys idempotently, keeping attrs and ids', () => {
    const ydoc = legacyDoc();
    const before = yDocToDoc(ydoc);
    expect(rekeyMarks(ydoc)).toBe(2);
    expect(rekeyMarks(ydoc)).toBe(0);
    expect(yDocToDoc(ydoc)).toEqual(before);
    const t = (ydoc.getXmlFragment(FRAGMENT_NAME).get(0) as Y.XmlElement).get(0) as Y.XmlText;
    const keys = (t.toDelta() as { attributes?: object }[]).flatMap((d) =>
      Object.keys(d.attributes ?? {}),
    );
    expect(keys.sort()).toEqual(
      [
        'italic',
        markKey({ type: 'comment_anchor', attrs: { id: 'c1' } }),
        markKey({ type: 'suggestion_insert', attrs: { id: 's1' } }),
      ].sort(),
    );
  });

  it('leaves current docs untouched', () => {
    const ydoc = docToYDoc(yDocToDoc(legacyDoc()));
    expect(rekeyMarks(ydoc)).toBe(0);
  });
});
