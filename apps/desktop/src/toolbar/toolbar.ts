/**
 * Formatting toolbar model (RAD-254): what each control shows and which Tiptap command it runs.
 * Kept free of Vue so the state and the commands can be unit-tested against a real editor.
 */
import type { Editor } from '@tiptap/core';
import { PARAGRAPH_STYLE_LABELS, type ParagraphStyle } from '@coauthor/editor';

/** The four styles in the toolbar dropdown (epic RAD-253, WP 1). */
export const TOOLBAR_STYLES = ['body', 'heading', 'scene_break', 'block_quote'] as const;
export type ToolbarStyle = (typeof TOOLBAR_STYLES)[number];
/** Any other paragraph style the caret can be in (shown, but set from the overflow menu). */
export type CaretStyle = ToolbarStyle | Exclude<ParagraphStyle, 'body' | 'block_quote'> | '';

export const STYLE_LABELS: Record<Exclude<CaretStyle, ''>, string> = {
  body: 'Body',
  heading: 'Heading',
  scene_break: 'Scene break',
  block_quote: 'Block quote',
  first: PARAGRAPH_STYLE_LABELS.first,
  epigraph: PARAGRAPH_STYLE_LABELS.epigraph,
  verse: PARAGRAPH_STYLE_LABELS.verse,
  centered: PARAGRAPH_STYLE_LABELS.centered,
};

/**
 * Windows shortcuts that are actually bound (verified): B/I/U by the manuscript marks
 * (Mod-b/i/u), undo/redo by the Yjs binding (Mod-z/Mod-y) only when bound to a Y.Doc. Other WP 7
 * shortcuts (styles, comment, find, sidebars) land with RAD-259 and are not advertised until then.
 */
export const SHORTCUTS = {
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Y',
  bold: 'Ctrl+B',
  italic: 'Ctrl+I',
  underline: 'Ctrl+U',
} as const;

export type Align = 'left' | 'center' | 'right' | 'justify';

export interface ToolbarState {
  style: CaretStyle;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  smallcaps: boolean;
  strike: boolean;
  align: Align;
  canUndo: boolean;
  canRedo: boolean;
  /** Undo history exists (Yjs-bound editor), so Ctrl+Z/Ctrl+Y really work. */
  hasHistory: boolean;
  editable: boolean;
}

/** Undo/redo come from the Yjs binding when bound; an unbound editor has no history. */
type HistoryCommands = { undo?: () => boolean; redo?: () => boolean };

export function caretStyle(editor: Editor): CaretStyle {
  const { selection } = editor.state;
  const node = (selection as { node?: { type: { name: string } } }).node;
  if (node?.type.name === 'scene_break') return 'scene_break';
  if (editor.isActive('heading')) return 'heading';
  if (!editor.isActive('paragraph')) return '';
  return ((editor.getAttributes('paragraph').style as ParagraphStyle) ?? 'body') as CaretStyle;
}

export function toolbarState(editor: Editor): ToolbarState {
  const can = editor.can() as unknown as HistoryCommands;
  const style = caretStyle(editor);
  return {
    style,
    bold: editor.isActive('bold'),
    italic: editor.isActive('italic'),
    underline: editor.isActive('underline'),
    smallcaps: editor.isActive('smallcaps'),
    strike: editor.isActive('strike'),
    // The manuscript schema stores alignment as paragraph style: only Centered exists today.
    align: style === 'centered' ? 'center' : 'left',
    canUndo: typeof can.undo === 'function' ? can.undo() : false,
    canRedo: typeof can.redo === 'function' ? can.redo() : false,
    hasHistory: typeof (editor.commands as unknown as HistoryCommands).undo === 'function',
    editable: editor.isEditable,
  };
}

/** Alignments the schema can store. Right and justify need a schema change (follow-up). */
export const SUPPORTED_ALIGN: readonly Align[] = ['left', 'center'];

export type ToolbarCommand =
  | 'undo'
  | 'redo'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'smallcaps'
  | 'strike'
  | 'pageBreak'
  | `style:${Exclude<CaretStyle, ''>}`
  | `align:${Align}`;

/** Run one toolbar command through Tiptap. Returns whether it applied. */
export function runCommand(editor: Editor, cmd: ToolbarCommand): boolean {
  // Read-only (load-error mode, RAD-237 restore lock): the toolbar never edits.
  if (!editor.isEditable) return false;
  const chain = editor.chain().focus();
  switch (cmd) {
    case 'undo':
    case 'redo': {
      const c = editor.commands as unknown as HistoryCommands;
      const fn = c[cmd];
      return typeof fn === 'function' ? fn() : false;
    }
    case 'bold':
      return chain.toggleBold().run();
    case 'italic':
      return chain.toggleItalic().run();
    case 'underline':
      return chain.toggleUnderline().run();
    case 'smallcaps':
      return chain.toggleSmallcaps().run();
    case 'strike':
      return chain.toggleStrike().run();
    case 'pageBreak':
      return chain.insertPageBreak().run();
    case 'style:heading':
      return chain.setNode('heading', { level: 1 }).run();
    case 'style:scene_break':
      return chain.insertSceneBreak().run();
    case 'align:left':
      return caretStyle(editor) === 'centered' ? setParagraph(editor, 'body') : true;
    case 'align:center':
      return setParagraph(editor, 'centered');
    case 'align:right':
    case 'align:justify':
      return false;
    default: {
      const style = cmd.slice('style:'.length) as ParagraphStyle;
      return setParagraph(editor, style);
    }
  }
}

function setParagraph(editor: Editor, style: ParagraphStyle): boolean {
  const chain = editor.chain().focus();
  if (editor.isActive('heading')) return chain.setNode('paragraph', { style }).run();
  return chain.setParagraphStyle(style).run();
}
