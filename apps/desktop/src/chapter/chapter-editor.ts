import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { DocNode, Section } from '@swarmdraft/schema';
import { firstLineText, reviewBlocksSplit, suggestSplitTitle } from '@swarmdraft/editor';
import { yDocToDoc } from '@swarmdraft/docx';
import type * as Y from 'yjs';

type PmViewDesc = {
  node?: { isBlock: boolean; type: { name: string } };
  posBefore: number;
};

function pmViewDesc(node: Node): PmViewDesc | undefined {
  return (node as Node & { pmViewDesc?: PmViewDesc }).pmViewDesc;
}

/**
 * Top-level block that owns `pos`. A gap between blocks belongs to the block
 * that starts there. A position past the last block belongs to that last block.
 */
export function blockIndexAt(doc: PMNode, pos: number): number {
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  const $pos = doc.resolve(clamped);
  if ($pos.depth > 0) return $pos.index(0);
  const index = $pos.index(0);
  if (index >= doc.childCount) return Math.max(0, doc.childCount - 1);
  return index;
}

/** Caret path (Ctrl+Shift+Enter): the block that contains the selection. */
export function splitBlockIndex(editor: Editor): number {
  return blockIndexAt(editor.state.doc, editor.state.selection.from);
}

/**
 * Paragraph under a right-click. Walks the clicked DOM node up to its top-level
 * block and uses that block's start. Screen coordinates are only a fallback,
 * and they are resolved to a block — never used as a block index, and never
 * turned into a text range that can cross into the next paragraph.
 */
export function blockIndexFromPointer(
  editor: Editor,
  event: { clientX: number; clientY: number; target: EventTarget | null },
): number | undefined {
  if (editor.isDestroyed) return undefined;
  const fromTarget = blockIndexFromMenuTarget(editor, event.target);
  if (fromTarget != null) return fromTarget;
  const hit = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!hit) return undefined;
  return blockIndexAt(editor.state.doc, hit.pos);
}

function blockIndexFromMenuTarget(editor: Editor, target: EventTarget | null): number | null {
  if (!(target instanceof Node) || editor.isDestroyed) return null;
  const { view } = editor;
  if (!view.dom.contains(target)) return null;
  let posBefore: number | null = null;
  for (let cur: Node | null = target; cur && cur !== view.dom; cur = cur.parentNode) {
    const desc = pmViewDesc(cur);
    if (!desc?.node?.isBlock || desc.node.type.name === 'doc') continue;
    posBefore = desc.posBefore;
  }
  if (posBefore == null) return null;
  return blockIndexAt(view.state.doc, posBefore);
}

export function splitDisabledAt(
  editable: boolean,
  docJson: DocNode,
  blockIndex: number,
): string | null {
  if (!editable) return 'Read-only';
  if (blockIndex <= 0) return 'Already the start of a chapter';
  const blocks = docJson.content ?? [];
  if (blockIndex >= blocks.length) return 'Nothing to move into a new chapter';
  const tail = blocks.slice(blockIndex);
  if (tail.every((b) => b.type !== 'scene_break' && !firstLineText(b))) {
    return 'Nothing to move into a new chapter';
  }
  if (reviewBlocksSplit(docJson, blockIndex)) return 'Resolve the change at this spot first';
  return null;
}

export function splitDisabledReason(editor: Editor | undefined, docJson: DocNode): string | null {
  if (!editor) return 'Read-only';
  return splitDisabledAt(editor.isEditable, docJson, splitBlockIndex(editor));
}

export function splitPopoverDefaults(
  editor: Editor,
  ydoc: Y.Doc,
  chapterNumber: number,
  blockIndex = splitBlockIndex(editor),
) {
  const shown = editor.state.doc.toJSON() as DocNode;
  // One block only. A range from the caret through the click would join the
  // previous paragraph's tail to this line.
  const block = shown.content?.[blockIndex] ?? yDocToDoc(ydoc).content?.[blockIndex];
  const line = firstLineText(block);
  const { title, removeLineDefault } = suggestSplitTitle(line, chapterNumber);
  return { title, removeLine: removeLineDefault, blockIndex };
}

export function chapterNeighbors(outline: readonly Section[], chapterId: string) {
  const chapters = outline.filter((s) => s.kind === 'chapter');
  const index = chapters.findIndex((c) => c.id === chapterId);
  return {
    chapters,
    index,
    prev: index > 0 ? chapters[index - 1] : undefined,
    next: index >= 0 && index < chapters.length - 1 ? chapters[index + 1] : undefined,
  };
}
