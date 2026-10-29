/**
 * Editor context menu actions (wp4, #54). Pure helpers so cut/copy/paste, styles, and comments
 * can be unit-tested against a real Tiptap editor without Vue.
 */
import type { Editor } from '@tiptap/core';
import { applyCommentAnchor } from '../review/comment';
import { runCommand, type ToolbarCommand } from '../toolbar/toolbar';

export type ContextMenuAction =
  | 'cut'
  | 'copy'
  | 'paste'
  | 'body'
  | 'heading'
  | 'block_quote'
  | 'scene_break'
  | 'comment'
  | 'ask-bot';

export type ContextMenuClipboard = {
  readText: () => Promise<string>;
  writeText: (text: string) => Promise<void>;
};

const STYLE_ACTIONS = new Set<ContextMenuAction>(['body', 'heading', 'block_quote', 'scene_break']);

/** Map wp4 style/comment accelerators (shared with the shortcuts sheet, #56). */
export function contextMenuActionForKey(ev: KeyboardEvent): ContextMenuAction | null {
  if (!(ev.ctrlKey || ev.metaKey) || !ev.altKey || ev.shiftKey) return null;
  switch (ev.key) {
    case '0':
      return 'body';
    case '1':
      return 'heading';
    case '2':
      return 'block_quote';
    case 'm':
    case 'M':
      return 'comment';
    default:
      return null;
  }
}

function defaultClipboard(): ContextMenuClipboard | undefined {
  const c = navigator.clipboard;
  if (!c?.readText || !c?.writeText) return undefined;
  return { readText: () => c.readText(), writeText: (text) => c.writeText(text) };
}

/** Which menu entries are inactive for the current editor state. */
export function contextMenuDisabled(editor: Editor | undefined): ReadonlySet<ContextMenuAction> {
  const out = new Set<ContextMenuAction>();
  const empty = !editor || editor.state.selection.empty;
  if (empty) {
    out.add('cut');
    out.add('copy');
    out.add('comment');
  }
  if (!editor?.isEditable) {
    out.add('cut');
    out.add('paste');
    out.add('comment');
    for (const id of STYLE_ACTIONS) out.add(id);
  }
  return out;
}

/** Run one context-menu command. Returns whether it applied (ask-bot is always true). */
export async function runContextMenuAction(
  editor: Editor,
  action: ContextMenuAction,
  deps: {
    clipboard?: ContextMenuClipboard;
    newCommentId?: () => string;
  } = {},
): Promise<boolean> {
  if (action === 'ask-bot') return true;

  const clip = deps.clipboard ?? defaultClipboard();

  switch (action) {
    case 'copy': {
      const { from, to, empty } = editor.state.selection;
      if (empty || !clip) return false;
      await clip.writeText(editor.state.doc.textBetween(from, to));
      editor.view.focus();
      return true;
    }
    case 'cut': {
      if (!editor.isEditable) return false;
      const { from, to, empty } = editor.state.selection;
      if (empty || !clip) return false;
      await clip.writeText(editor.state.doc.textBetween(from, to));
      return editor.chain().focus().deleteSelection().run();
    }
    case 'paste': {
      if (!editor.isEditable || !clip) return false;
      const text = await clip.readText();
      if (!text) return false;
      return editor.chain().focus().insertContent(text).run();
    }
    case 'comment': {
      if (!editor.isEditable) return false;
      const { from, to, empty } = editor.state.selection;
      if (empty) return false;
      const id = deps.newCommentId?.() ?? crypto.randomUUID();
      if (!applyCommentAnchor(editor.view, from, to, id)) return false;
      editor.view.focus();
      return true;
    }
    default:
      if (!STYLE_ACTIONS.has(action)) return false;
      return runCommand(editor, `style:${action}` as ToolbarCommand);
  }
}
