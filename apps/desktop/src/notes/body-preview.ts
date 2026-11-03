import * as Y from 'yjs';
import { bodyField } from './doc';

/** Plain-text preview of a note body for card lists (#278). */
export function noteBodyPreview(doc: Y.Doc, noteId: string, maxLen = 400): string {
  const frag = doc.getXmlFragment(bodyField(noteId));
  const text = xmlFragmentPlainText(frag).replace(/\s+/g, ' ').trim();
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}…`;
}

function xmlFragmentPlainText(node: Y.XmlFragment | Y.XmlElement | Y.XmlText): string {
  if (node instanceof Y.XmlText) return node.toString();
  let out = '';
  for (let i = 0; i < node.length; i++) {
    const child = node.get(i);
    if (child instanceof Y.AbstractType) out += xmlFragmentPlainText(child as Y.XmlFragment);
  }
  return out;
}
