import { InputRule, Mark, Node, mergeAttributes, type Extensions } from '@tiptap/core';
import type { ParseRule } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { PARAGRAPH_STYLES, type ParagraphStyle } from './content';
import { ReviewGuard } from './review';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    manuscriptParagraph: {
      /** Set the paragraph style of every paragraph in the selection. */
      setParagraphStyle: (style: ParagraphStyle) => ReturnType;
    };
    manuscriptBlocks: {
      insertSceneBreak: () => ReturnType;
      insertPageBreak: () => ReturnType;
    };
    manuscriptMarks: {
      toggleItalic: () => ReturnType;
      toggleBold: () => ReturnType;
      toggleSmallcaps: () => ReturnType;
      toggleUnderline: () => ReturnType;
      toggleStrike: () => ReturnType;
    };
  }
}

const Doc = Node.create({ name: 'doc', topNode: true, content: 'block+' });
const Text = Node.create({ name: 'text', group: 'inline' });

/** Marker line that becomes a scene break when typed on its own. */
export const SCENE_BREAK_MARKER = '***';

/** Canonical centered glyph in the editor; storage and export keep `marker`. */
export const SCENE_BREAK_DISPLAY = '* * *';

export const Paragraph = Node.create({
  name: 'paragraph',
  group: 'block',
  content: 'inline*',
  priority: 1000,
  addAttributes() {
    return {
      style: {
        default: 'body',
        parseHTML: (el) => {
          const s = el.getAttribute('data-style');
          return s && (PARAGRAPH_STYLES as readonly string[]).includes(s) ? s : 'body';
        },
        renderHTML: (attrs) => ({ 'data-style': attrs.style, class: `p-${attrs.style}` }),
      },
    };
  },
  parseHTML: () => [{ tag: 'p' }],
  renderHTML: ({ HTMLAttributes }) => ['p', HTMLAttributes, 0],
  addCommands() {
    return {
      setParagraphStyle:
        (style) =>
        ({ commands }) =>
          (PARAGRAPH_STYLES as readonly string[]).includes(style) &&
          commands.updateAttributes('paragraph', { style }),
    };
  },
  addInputRules() {
    const type = this.type;
    return [
      new InputRule({
        find: /\*\*\*$/,
        handler: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type !== type || !/^\*{2,3}$/.test($from.parent.textContent))
            return null;
          const start = $from.before();
          const end = $from.after();
          const sceneBreak = state.schema.nodes.scene_break!.create({ marker: SCENE_BREAK_MARKER });
          const next = type.create({ style: 'first' });
          const tr = state.tr.replaceWith(start, end, [sceneBreak, next]);
          tr.setSelection(TextSelection.create(tr.doc, start + sceneBreak.nodeSize + 1));
        },
      }),
    ];
  },
});

export const Heading = Node.create({
  name: 'heading',
  group: 'block',
  content: 'inline*',
  defining: true,
  addAttributes() {
    return { level: { default: 1, parseHTML: (el) => Number(el.tagName.slice(1)) || 1 } };
  },
  parseHTML: () => [1, 2, 3, 4, 5, 6].map((l) => ({ tag: `h${l}` })),
  renderHTML: ({ node, HTMLAttributes }) => {
    const level = Math.min(6, Math.max(1, Number(node.attrs.level) || 1));
    const { level: _omit, ...rest } = HTMLAttributes;
    void _omit;
    return [`h${level}`, rest, 0];
  },
});

export const SceneBreak = Node.create({
  name: 'scene_break',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      marker: {
        default: SCENE_BREAK_MARKER,
        parseHTML: (el) => el.getAttribute('data-marker') ?? SCENE_BREAK_MARKER,
        renderHTML: (attrs) => ({ 'data-marker': attrs.marker }),
      },
    };
  },
  parseHTML: () => [{ tag: 'div[data-scene-break]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes, { 'data-scene-break': '', class: 'scene-break' }),
    SCENE_BREAK_DISPLAY,
  ],
  addNodeView() {
    return ({ HTMLAttributes }) => {
      const dom = document.createElement('div');
      const attrs = mergeAttributes(HTMLAttributes, {
        'data-scene-break': '',
        class: 'scene-break',
      });
      for (const [key, value] of Object.entries(attrs)) {
        if (value == null || value === false) continue;
        dom.setAttribute(key, value === true ? '' : String(value));
      }
      dom.textContent = SCENE_BREAK_DISPLAY;
      return { dom };
    };
  },
  addCommands() {
    return {
      insertSceneBreak:
        () =>
        ({ commands }) =>
          commands.insertContent([
            { type: 'scene_break', attrs: { marker: SCENE_BREAK_MARKER } },
            { type: 'paragraph', attrs: { style: 'first' } },
          ]),
      insertPageBreak:
        () =>
        ({ commands }) =>
          commands.insertContent([{ type: 'page_break' }, { type: 'paragraph' }]),
    };
  },
});

export const PageBreak = Node.create({
  name: 'page_break',
  group: 'block',
  atom: true,
  selectable: true,
  parseHTML: () => [{ tag: 'div[data-page-break]' }],
  renderHTML: () => ['div', { 'data-page-break': '', class: 'page-break' }],
});

export const HardBreak = Node.create({
  name: 'hard_break',
  group: 'inline',
  inline: true,
  selectable: false,
  parseHTML: () => [{ tag: 'br' }],
  renderHTML: () => ['br'],
  addKeyboardShortcuts() {
    return {
      'Shift-Enter': () => this.editor.commands.insertContent({ type: 'hard_break' }),
    };
  },
});

/**
 * Inline note reference (footnote or endnote). The note body is kept in attrs as imported
 * (schema `FootnoteNode`), rendered as a superscript marker; editing notes is out of scope.
 */
export const Footnote = Node.create({
  name: 'footnote',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      id: { default: '', parseHTML: (el: HTMLElement) => el.getAttribute('data-id') ?? '' },
      kind: {
        default: 'footnote',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-kind') ?? 'footnote',
      },
      text: { default: '', parseHTML: (el: HTMLElement) => el.getAttribute('data-text') ?? '' },
      content: { default: [], rendered: false },
    };
  },
  parseHTML: () => [{ tag: 'sup[data-note]' }],
  renderHTML: ({ node }) => [
    'sup',
    {
      'data-note': '',
      'data-id': String(node.attrs.id),
      'data-kind': String(node.attrs.kind),
      'data-text': String(node.attrs.text),
      title: String(node.attrs.text),
      class: node.attrs.kind === 'endnote' ? 'note endnote' : 'note footnote',
    },
    node.attrs.kind === 'endnote' ? '\u2020' : '*',
  ],
});

/** Placeholder for an image that is not imported yet (RAD-217); shows its description. */
export const ImagePlaceholder = Node.create({
  name: 'image',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      alt: { default: '', parseHTML: (el: HTMLElement) => el.getAttribute('data-alt') ?? '' },
    };
  },
  parseHTML: () => [{ tag: 'span[data-image-placeholder]' }],
  renderHTML: ({ node }) => [
    'span',
    {
      'data-image-placeholder': '',
      'data-alt': String(node.attrs.alt),
      class: 'image-placeholder',
    },
    `[image${node.attrs.alt ? `: ${String(node.attrs.alt)}` : ''}]`,
  ],
});

function formatMark(
  name: 'italic' | 'bold' | 'smallcaps' | 'underline' | 'strike',
  tag: string,
  parse: ParseRule[],
  key?: string,
) {
  const command =
    `toggle${name.charAt(0).toUpperCase()}${name.slice(1)}` as `toggle${Capitalize<typeof name>}`;
  return Mark.create({
    name,
    parseHTML: () => parse,
    renderHTML: () => (name === 'smallcaps' ? ['span', { class: 'smallcaps' }, 0] : [tag, 0]),
    addCommands() {
      return {
        [command]:
          () =>
          ({ commands }: { commands: { toggleMark: (n: string) => boolean } }) =>
            commands.toggleMark(name),
      } as never;
    },
    addKeyboardShortcuts() {
      return key ? { [key]: () => this.editor.commands.toggleMark(name) } : {};
    },
  });
}

export const Italic = formatMark('italic', 'em', [{ tag: 'em' }, { tag: 'i' }], 'Mod-i');
export const Bold = formatMark('bold', 'strong', [{ tag: 'strong' }, { tag: 'b' }], 'Mod-b');
export const Smallcaps = formatMark('smallcaps', 'span', [
  { tag: 'span.smallcaps' },
  { style: 'font-variant=small-caps' },
]);
export const Underline = formatMark('underline', 'u', [{ tag: 'u' }], 'Mod-u');
export const Strike = formatMark('strike', 's', [
  { tag: 's' },
  { tag: 'del:not([data-suggestion])' },
]);

export const Link = Mark.create({
  name: 'link',
  inclusive: false,
  addAttributes() {
    return { href: { default: '' } };
  },
  parseHTML: () => [{ tag: 'a[href]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'a',
    mergeAttributes(HTMLAttributes, { rel: 'noopener noreferrer nofollow' }),
    0,
  ],
});

const reviewAttrs = (keys: string[]) => () =>
  Object.fromEntries(
    keys.map((k) => [
      k,
      {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute(`data-${k}`) ?? '',
        renderHTML: (attrs: Record<string, string>) => ({ [`data-${k}`]: attrs[k] }),
      },
    ]),
  );

/** Comment and suggestion marks may overlap with another of the same type, hence `excludes: ''`. */
export const CommentAnchor = Mark.create({
  name: 'comment_anchor',
  excludes: '',
  inclusive: false,
  addAttributes: reviewAttrs(['id']),
  parseHTML: () => [{ tag: 'span[data-comment]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'span',
    mergeAttributes(HTMLAttributes, { 'data-comment': '', class: 'comment-anchor' }),
    0,
  ],
});

export const SuggestionInsert = Mark.create({
  name: 'suggestion_insert',
  excludes: '',
  inclusive: false,
  addAttributes: reviewAttrs(['id', 'author', 'ts']),
  parseHTML: () => [{ tag: 'ins[data-suggestion]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'ins',
    mergeAttributes(HTMLAttributes, { 'data-suggestion': '', class: 'suggestion-insert' }),
    0,
  ],
});

export const SuggestionDelete = Mark.create({
  name: 'suggestion_delete',
  excludes: '',
  inclusive: false,
  addAttributes: reviewAttrs(['id', 'author', 'ts']),
  parseHTML: () => [{ tag: 'del[data-suggestion]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'del',
    mergeAttributes(HTMLAttributes, { 'data-suggestion': '', class: 'suggestion-delete' }),
    0,
  ],
});

export const FormatChange = Mark.create({
  name: 'format_change',
  excludes: '',
  inclusive: false,
  addAttributes: reviewAttrs(['id', 'author', 'ts', 'target', 'before', 'after']),
  parseHTML: () => [{ tag: 'span[data-format-change]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'span',
    mergeAttributes(HTMLAttributes, { 'data-format-change': '', class: 'format-change' }),
    0,
  ],
});

/** Every extension the manuscript editor needs. No other schema is loaded. */
export function manuscriptExtensions(): Extensions {
  return [
    Doc,
    Text,
    Paragraph,
    Heading,
    SceneBreak,
    PageBreak,
    HardBreak,
    Footnote,
    ImagePlaceholder,
    Italic,
    Bold,
    Smallcaps,
    Underline,
    Strike,
    Link,
    CommentAnchor,
    SuggestionInsert,
    SuggestionDelete,
    FormatChange,
    ReviewGuard,
  ];
}
