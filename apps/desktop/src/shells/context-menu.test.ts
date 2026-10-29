import { describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { manuscriptEditorOptions } from '@coauthor/editor';
import { collectReviewItems } from '@coauthor/editor';
import { SAMPLE_DOC } from '../fixtures/sample';
import {
  contextMenuDisabled,
  contextMenuActionForKey,
  runContextMenuAction,
  type ContextMenuClipboard,
} from './context-menu';

function editor(content = SAMPLE_DOC) {
  return new Editor(manuscriptEditorOptions({ content }));
}

function selectText(e: Editor, snippet: string) {
  let from = -1;
  let to = -1;
  e.state.doc.descendants((node, pos) => {
    if (!node.isText || from >= 0) return;
    const i = node.text!.indexOf(snippet);
    if (i >= 0) {
      from = pos + i;
      to = from + snippet.length;
    }
  });
  if (from < 0) throw new Error(`snippet not found: ${snippet}`);
  e.commands.setTextSelection({ from, to });
}

describe('context menu actions (#54)', () => {
  it('maps Ctrl+Alt+0/1/2/M to style and comment actions (#56)', () => {
    const key = (key: string) =>
      contextMenuActionForKey(
        new KeyboardEvent('keydown', { key, ctrlKey: true, altKey: true, bubbles: true }),
      );
    expect(key('0')).toBe('body');
    expect(key('1')).toBe('heading');
    expect(key('2')).toBe('block_quote');
    expect(key('m')).toBe('comment');
    expect(
      contextMenuActionForKey(
        new KeyboardEvent('keydown', { key: '1', ctrlKey: true, altKey: true, shiftKey: true }),
      ),
    ).toBeNull();
  });

  it('marks cut, copy, and comment disabled with an empty selection', () => {
    const e = editor();
    const disabled = contextMenuDisabled(e);
    expect(disabled.has('cut')).toBe(true);
    expect(disabled.has('copy')).toBe(true);
    expect(disabled.has('comment')).toBe(true);
    expect(disabled.has('paste')).toBe(false);
    e.destroy();
  });

  it('cut copies the selection then deletes it', async () => {
    const e = editor();
    selectText(e, 'rain');
    const clip: ContextMenuClipboard = {
      readText: vi.fn(),
      writeText: vi.fn().mockResolvedValue(undefined),
    };
    const before = e.getText();
    expect(await runContextMenuAction(e, 'cut', { clipboard: clip })).toBe(true);
    expect(clip.writeText).toHaveBeenCalledWith('rain');
    expect(e.getText()).not.toContain('rain');
    expect(before.length).toBeGreaterThan(e.getText().length);
    e.destroy();
  });

  it('copy writes the selection without changing the document', async () => {
    const e = editor();
    selectText(e, 'lantern');
    const clip: ContextMenuClipboard = {
      readText: vi.fn(),
      writeText: vi.fn().mockResolvedValue(undefined),
    };
    const before = e.getJSON();
    expect(await runContextMenuAction(e, 'copy', { clipboard: clip })).toBe(true);
    expect(clip.writeText).toHaveBeenCalledWith('lantern');
    expect(e.getJSON()).toEqual(before);
    e.destroy();
  });

  it('paste inserts clipboard text at the cursor', async () => {
    const e = editor();
    e.commands.setTextSelection(e.state.doc.content.size - 2);
    const clip: ContextMenuClipboard = {
      readText: vi.fn().mockResolvedValue(' Pasted'),
      writeText: vi.fn(),
    };
    expect(await runContextMenuAction(e, 'paste', { clipboard: clip })).toBe(true);
    expect(e.getText()).toContain('Pasted');
    e.destroy();
  });

  it('add comment anchors the selection through the trusted path', async () => {
    const e = editor();
    selectText(e, 'Morning');
    expect(await runContextMenuAction(e, 'comment', { newCommentId: () => 'human-c1' })).toBe(true);
    expect(collectReviewItems(e.state.doc).some((r) => r.id === 'human-c1')).toBe(true);
    e.destroy();
  });

  it('applies paragraph styles like the toolbar', async () => {
    const e = editor();
    e.commands.setTextSelection(1);
    expect(await runContextMenuAction(e, 'heading')).toBe(true);
    expect(e.isActive('heading')).toBe(true);
    e.destroy();
  });
});
