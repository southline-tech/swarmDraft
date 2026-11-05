import type { Editor } from '@tiptap/core';
import type { DocNode, Section } from '@swarmdraft/schema';
import { firstLineText, reviewBlocksSplit, suggestSplitTitle } from '@swarmdraft/editor';
import { yDocToDoc } from '@swarmdraft/docx';
import type * as Y from 'yjs';

export function splitBlockIndex(editor: Editor): number {
  return editor.state.selection.$from.index(0);
}

export function splitDisabledReason(editor: Editor | undefined, docJson: DocNode): string | null {
  if (!editor?.isEditable) return 'Read-only';
  const blockIndex = splitBlockIndex(editor);
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

export function splitPopoverDefaults(editor: Editor, ydoc: Y.Doc, chapterNumber: number) {
  const blockIndex = splitBlockIndex(editor);
  const doc = yDocToDoc(ydoc);
  const line = firstLineText(doc.content[blockIndex]);
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
