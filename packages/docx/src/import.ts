/**
 * .docx -> structured manuscript importer (RAD-218).
 *
 * Reads the OOXML parts directly (no external converter) so we keep full
 * control over the signals that matter for a finished novel manuscript:
 * direct formatting used as headings, several scene-break conventions,
 * tracked changes, comments and footnotes.
 */
import { strFromU8 } from 'fflate';
import { safeUnzip } from './zip';
import { sectionDocId, type SectionKind } from '@coauthor/schema';
import { child, kids, onOff, parseXml, textOf, val, type XmlElement } from './xml';
import {
  normalizeInline,
  plainText,
  type BlockNode,
  type DocNode,
  type InlineNode,
  type Mark,
  type ParagraphNode,
  type ParagraphStyle,
} from './model';
import { ReportBuilder, type ImportReport } from './report';

export interface ImportedSection {
  id: string;
  kind: SectionKind;
  title: string;
  parentId?: string;
  docId: string;
  /** ProseMirror JSON for this section's own Yjs document. */
  content: DocNode;
}

export interface ImportedComment {
  id: string;
  sectionId: string;
  author: string;
  date: string;
  body: string;
}

export interface ImportedManuscript {
  title: string;
  author?: string;
  sections: ImportedSection[];
  comments: ImportedComment[];
  report: ImportReport;
  /** Warning messages from the report, for simple UIs. */
  warnings: string[];
}

export interface ImportOptions {
  manuscriptId?: string;
  /** Filename stem (no extension) when the document has no in-body title signal. */
  fileNameStem?: string;
}

// ---------------------------------------------------------------------------
// Patterns

const NUMBER_WORDS =
  'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred';
const NUM = `(?:\\d+|[ivxlcdm]+|(?:(?:${NUMBER_WORDS})[\\s-]*)+)`;
const CHAPTER_RE = new RegExp(`^(?:chapter|ch\\.)\\s+${NUM}\\s*(?:[:.\\-–—]\\s*\\S.*)?$`, 'i');
const PART_RE = new RegExp(`^(?:part|book)\\s+${NUM}\\s*(?:[:.\\-–—]\\s*\\S.*)?$`, 'i');
const BACK_MATTER_RE =
  /^(acknowledge?ments?|about the author|afterword|author'?s note|author’s note|glossary|also by .+|reading group guide|discussion questions|notes|bibliography|appendix\b.*|epilog(?:ue)?(?:\s*[:.\-–—]\s*\S.*)?)$/i;
const FRONT_TITLE_RE = /^(prologue|foreword|preface|introduction)$/i;
/** A paragraph consisting only of break glyphs (and spaces) is a scene break. */
const SCENE_BREAK_RE = /^[*#~•·❦❧⁂✦✧◆◇○●§※=_\-–—]+$/u;

const PARA_STYLES: Record<string, ParagraphStyle> = {
  quote: 'block_quote',
  intensequote: 'block_quote',
  blocktext: 'block_quote',
  blockquote: 'block_quote',
  epigraph: 'epigraph',
  verse: 'verse',
  poem: 'verse',
  centered: 'centered',
};
const KNOWN_PARA_STYLES = new Set([
  'normal',
  'bodytext',
  'bodytext2',
  'bodytext3',
  'bodytextfirstindent',
  'firstparagraph',
  'nospacing',
  'normalweb',
  'title',
  'subtitle',
  'footnotetext',
  'parttitle',
  'backmattertitle',
  'scenebreak',
  ...Object.keys(PARA_STYLES),
]);
const CHAR_STYLES: Record<string, Mark['type'] | null> = {
  emphasis: 'italic',
  subtleemphasis: 'italic',
  intenseemphasis: 'italic',
  strong: 'bold',
  bookTitle: 'italic',
  commentreference: null,
  footnotereference: null,
  imageplaceholder: null,
  endnotereference: null,
  hyperlink: null,
  defaultparagraphfont: null,
};

// ---------------------------------------------------------------------------
// Package reading

interface StyleInfo {
  id: string;
  name: string;
  type: string;
  basedOn?: string;
  outlineLevel?: number;
}

interface Pkg {
  files: Record<string, Uint8Array>;
  read(path: string): XmlElement | undefined;
}

/** Zip-bomb guards: cap input size, per-part and total inflated size, and inflate only XML parts we read. */
export const DOCX_LIMITS = {
  maxInputBytes: 100 * 1024 * 1024,
  maxPartBytes: 32 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
};
const NEEDED_PART =
  /^(\[Content_Types\]\.xml|_rels\/\.rels|docProps\/core\.xml|word\/[^/]+\.xml|word\/_rels\/document\.xml\.rels)$/;

function openPackage(bytes: Uint8Array): Pkg {
  const L = DOCX_LIMITS;
  if (bytes.length > L.maxInputBytes)
    throw new Error(`File too large (${bytes.length} bytes; limit ${L.maxInputBytes})`);
  const files = safeUnzip(bytes, (name) => NEEDED_PART.test(name), L);
  return {
    files,
    read(path) {
      const f = files[path];
      return f ? parseXml(strFromU8(f)) : undefined;
    },
  };
}

function relTargets(pkg: Pkg): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of kids(pkg.read('word/_rels/document.xml.rels'), 'Relationship')) {
    const type = (r.attrs.Type ?? '').split('/').pop() ?? '';
    const target = (r.attrs.Target ?? '').replace(/^\/?word\//, '').replace(/^\//, '');
    out.set(type, `word/${target}`);
  }
  return out;
}

function relAll(pkg: Pkg, type: string): string[] {
  return kids(pkg.read('word/_rels/document.xml.rels'), 'Relationship')
    .filter((r) => (r.attrs.Type ?? '').split('/').pop() === type)
    .map((r) => (r.attrs.Target ?? '').replace(/^\/?word\//, '').replace(/^\//, ''));
}

function readStyles(pkg: Pkg): Map<string, StyleInfo> {
  const map = new Map<string, StyleInfo>();
  for (const s of kids(pkg.read('word/styles.xml'), 'w:style')) {
    const id = s.attrs['w:styleId'] ?? '';
    const name = val(s, 'w:name') ?? id;
    const lvl = val(child(s, 'w:pPr'), 'w:outlineLvl');
    const info: StyleInfo = { id, name, type: s.attrs['w:type'] ?? 'paragraph' };
    const based = val(s, 'w:basedOn');
    if (based) info.basedOn = based;
    if (lvl !== undefined) info.outlineLevel = Number(lvl) + 1;
    map.set(id, info);
  }
  return map;
}

function headingLevel(styleId: string | undefined, styles: Map<string, StyleInfo>): number {
  let id = styleId;
  for (let i = 0; id && i < 10; i++) {
    const s = styles.get(id);
    const m = /^heading\s*(\d)$/i.exec(s?.name ?? id) ?? /^heading(\d)$/i.exec(id);
    if (m) return Number(m[1]);
    if (s?.outlineLevel && s.outlineLevel <= 9) return s.outlineLevel;
    id = s?.basedOn;
  }
  return 0;
}

interface NoteDef {
  text: string;
  content: ParagraphNode[];
}

/** Notes keep their paragraphs and inline formatting (italic, bold, ...). */
function readNotes(root: XmlElement | undefined, tag: string, ctx: Ctx): Map<string, NoteDef> {
  const out = new Map<string, NoteDef>();
  for (const n of kids(root, tag)) {
    if (n.attrs['w:type'] && n.attrs['w:type'] !== 'normal') continue;
    const content: ParagraphNode[] = [];
    ctx.story = newStory();
    const paras = kids(n, 'w:p').map((p) => extractParagraph(p, ctx));
    finishStory(ctx);
    for (const para of paras) {
      const inline = normalizeInline(para.inline);
      const first = inline[0];
      if (first && first.type === 'text') {
        first.text = first.text.replace(/^\s+/, '');
        if (!first.text) inline.shift();
      }
      if (inline.length)
        content.push({ type: 'paragraph', attrs: { style: 'body' }, content: inline });
    }
    const text = content
      .map((p) => plainText(p.content))
      .join('\n')
      .trim();
    out.set(n.attrs['w:id'] ?? '', { text, content });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Paragraph extraction

interface Para {
  inline: InlineNode[];
  /** Visible text (tracked deletions excluded), used for detection. */
  text: string;
  styleId: string;
  styleName: string;
  level: number;
  centered: boolean;
  indLeft: number;
  indRight: number;
  allBold: boolean;
  allItalic: boolean;
  maxSize: number;
  breakBefore: boolean;
  breakAfter: boolean;
  hasNote: boolean;
}

interface Story {
  /** Mapped ids of currently open ranges. */
  open: Set<string>;
  /** Original w:id -> queue of open mapped ids. */
  openMap: Map<string, string[]>;
  /** Mapped id -> index of the paragraph where its range started. */
  starts: Map<string, number>;
  /** Open ranges that have not covered any text yet. */
  empty: Set<string>;
  /** Point / reference-only comments waiting for the next text to anchor on. */
  pending: Set<string>;
  /** Inline arrays of the story's paragraphs, in order. */
  paras: InlineNode[][];
}

function newStory(): Story {
  return {
    open: new Set(),
    openMap: new Map(),
    starts: new Map(),
    empty: new Set(),
    pending: new Set(),
    paras: [],
  };
}

const anchor = (id: string): Mark => ({ type: 'comment_anchor', attrs: { id } });

/**
 * End of a story (body, or one note): ranges still open are cut back to the
 * paragraph where they started, so a missing or misplaced end never stretches
 * a comment over the rest of the document. Pending point comments anchor on
 * the story's last text.
 */
function finishStory(ctx: Ctx): void {
  const st = ctx.story;
  for (const id of st.open) {
    ctx.report.add(
      'warning',
      'unclosed_comment',
      'Comment range was never closed; limited to the paragraph where it starts',
      ctx.commentDetail(id, id),
    );
    const from = st.starts.get(id) ?? 0;
    for (const inline of st.paras.slice(from + 1)) {
      for (const n of inline)
        if (n.type === 'text' && n.marks)
          n.marks = n.marks.filter((m) => !(m.type === 'comment_anchor' && m.attrs.id === id));
      const fixed = normalizeInline(
        inline.map((n) =>
          n.type === 'text' && n.marks?.length === 0 ? { type: 'text' as const, text: n.text } : n,
        ),
      );
      inline.splice(0, inline.length, ...fixed);
    }
  }
  for (const id of st.pending) {
    const last = [...st.paras]
      .reverse()
      .flatMap((p) => [...p].reverse())
      .find((n) => n.type === 'text');
    if (last && last.type === 'text') last.marks = [...(last.marks ?? []), anchor(id)];
  }
  ctx.story = newStory();
}

interface Ctx {
  styles: Map<string, StyleInfo>;
  footnotes: Map<string, NoteDef>;
  endnotes: Map<string, NoteDef>;
  report: ReportBuilder;
  /** Comment range state for the story being read (body, or one note). */
  story: Story;
  /** Original ids that had a commentRangeStart anywhere. */
  startedComments: Set<string>;
  usedComments: Set<string>;
  /** Unique ids for comments.xml entries, in file order, per original w:id. */
  commentIds: Map<string, string[]>;
  /** Fresh comment ids already reported while reading comments.xml. */
  commentRemapped: Set<string>;
  /** Number of comments.xml definitions per original w:id. */
  commentDefCount: Map<string, number>;
  /** Last mapped id used for each original w:id (for continued ranges). */
  lastCommentId: Map<string, string>;
  /** Original docx w:id for each anchor id we assigned (for orphan_anchor reports). */
  anchorOrig: Map<string, string>;
  /** Anchor ids that were zero-width in the docx (anchored on the next text by us). */
  pointAnchors: Set<string>;
  /** "id: snippet" detail for report warnings. */
  commentDetail: (orig: string, id?: string) => string;
  freshId: () => string;
  suggestions: Set<string>;
}

function runMarks(
  rPr: XmlElement | undefined,
  ctx: Ctx,
  sample: () => string,
  isNoteRun: boolean,
): Mark[] {
  const marks: Mark[] = [];
  const rStyle = val(rPr, 'w:rStyle');
  if (rStyle) {
    const key = Object.keys(CHAR_STYLES).find((k) => k.toLowerCase() === rStyle.toLowerCase());
    const mapped = key !== undefined ? CHAR_STYLES[key] : undefined;
    if (mapped) marks.push({ type: mapped } as Mark);
    else if (mapped === undefined) {
      const name = ctx.styles.get(rStyle)?.name ?? rStyle;
      ctx.report.add('warning', 'unmapped_character_style', `Unmapped character style "${name}"`);
    }
  }
  if (onOff(rPr, 'w:b')) marks.push({ type: 'bold' });
  if (onOff(rPr, 'w:i')) marks.push({ type: 'italic' });
  if (onOff(rPr, 'w:smallCaps')) marks.push({ type: 'smallcaps' });
  if (onOff(rPr, 'w:caps'))
    ctx.report.add(
      'info',
      'all_caps',
      'All-caps formatting not kept (text kept as typed)',
      sample(),
    );
  const uEl = child(rPr, 'w:u');
  const u = uEl ? (uEl.attrs['w:val'] ?? 'single') : undefined;
  if (u !== undefined && u !== 'none') marks.push({ type: 'underline' });
  if (onOff(rPr, 'w:strike') || onOff(rPr, 'w:dstrike')) marks.push({ type: 'strike' });
  const va = val(rPr, 'w:vertAlign');
  if (va && va !== 'baseline' && !isNoteRun)
    ctx.report.add('warning', 'vert_align', `Unsupported ${va} text kept as normal text`, sample());
  if (child(rPr, 'w:rFonts') || child(rPr, 'w:sz') || child(rPr, 'w:color'))
    ctx.report.add(
      'info',
      'direct_font',
      'Direct font, size and color settings ignored on purpose (theme controls typography; italic, bold, small caps, underline and strike kept)',
    );
  if (child(rPr, 'w:highlight'))
    ctx.report.add('info', 'highlight', 'Highlighting dropped', sample());
  return marks;
}

function extractParagraph(p: XmlElement, ctx: Ctx): Para {
  const pPr = child(p, 'w:pPr');
  const styleId = val(pPr, 'w:pStyle') ?? 'Normal';
  const ind = child(pPr, 'w:ind');
  const jc = val(pPr, 'w:jc');
  const para: Para = {
    inline: [],
    text: '',
    styleId,
    styleName: ctx.styles.get(styleId)?.name ?? styleId,
    level: headingLevel(styleId, ctx.styles),
    centered: jc === 'center',
    indLeft: Number(ind?.attrs['w:left'] ?? ind?.attrs['w:start'] ?? 0),
    indRight: Number(ind?.attrs['w:right'] ?? ind?.attrs['w:end'] ?? 0),
    allBold: true,
    allItalic: true,
    maxSize: 0,
    breakBefore: onOff(pPr, 'w:pageBreakBefore') === true,
    breakAfter: !!child(pPr, 'w:sectPr'),
    hasNote: false,
  };
  let sawText = false;
  const sample = () => (para.text || plainText(para.inline)).trim().slice(0, 40);

  const pushText = (text: string, marks: Mark[], visible: boolean) => {
    para.inline.push(marks.length ? { type: 'text', text, marks } : { type: 'text', text });
    if (visible) para.text += text;
  };

  const walkRun = (r: XmlElement, extra: Mark[], deleted: boolean) => {
    const rPr = child(r, 'w:rPr');
    if (val(rPr, 'w:rStyle') === 'ImagePlaceholder') {
      const alt = kids(r, 'w:t')
        .map(textOf)
        .join('')
        .replace(/^\[image: ?/, '')
        .replace(/\]$/, '');
      para.inline.push({ type: 'image', attrs: { alt } });
      sawText = true;
      return;
    }
    const isNoteRun = [
      'w:footnoteReference',
      'w:endnoteReference',
      'w:footnoteRef',
      'w:endnoteRef',
    ].some((n) => !!child(r, n));
    const marks = [...runMarks(rPr, ctx, sample, isNoteRun), ...extra];
    const st = ctx.story;
    for (const id of st.open) marks.push(anchor(id));
    const hasText = kids(r).some(
      (k) => (k.name === 'w:t' || k.name === 'w:delText') && textOf(k).length > 0,
    );
    if (hasText) {
      for (const id of st.pending) marks.push(anchor(id));
      st.pending.clear();
      st.empty.clear();
    }
    const types = new Set(marks.map((m) => m.type));
    const sz = Number(val(rPr, 'w:sz') ?? 0);
    for (const c of kids(r)) {
      switch (c.name) {
        case 'w:t':
        case 'w:delText': {
          const t = textOf(c);
          if (t.trim() && !deleted) {
            sawText = true;
            if (!types.has('bold')) para.allBold = false;
            if (!types.has('italic')) para.allItalic = false;
            para.maxSize = Math.max(para.maxSize, sz);
          }
          pushText(t, marks, !deleted);
          break;
        }
        case 'w:tab':
          pushText('\t', marks, !deleted);
          break;
        case 'w:noBreakHyphen':
          pushText('\u2011', marks, !deleted);
          break;
        case 'w:sym': {
          const code = parseInt(c.attrs['w:char'] ?? '', 16);
          if (Number.isFinite(code)) pushText(String.fromCodePoint(code), marks, !deleted);
          break;
        }
        case 'w:br':
        case 'w:cr':
          if (c.attrs['w:type'] === 'page' || c.attrs['w:type'] === 'column') {
            if (sawText) para.breakAfter = true;
            else para.breakBefore = true;
          } else {
            para.inline.push({ type: 'hard_break' });
            if (!deleted) para.text += '\n';
          }
          break;
        case 'w:commentReference': {
          // Reference-only comment (no range): anchor it at this point.
          const orig = c.attrs['w:id'] ?? '';
          if (!ctx.startedComments.has(orig)) {
            const id = ctx.commentIds.get(orig)?.shift();
            if (id) {
              st.pending.add(id);
              ctx.pointAnchors.add(id);
            }
          }
          break;
        }
        case 'w:footnoteReference':
        case 'w:endnoteReference': {
          const id = c.attrs['w:id'] ?? '';
          const notes = c.name === 'w:footnoteReference' ? ctx.footnotes : ctx.endnotes;
          const def = notes.get(id);
          if (def === undefined)
            ctx.report.add('warning', 'missing_note', `Note ${id} referenced but not found`);
          const kind = c.name === 'w:footnoteReference' ? 'footnote' : 'endnote';
          para.inline.push({
            type: 'footnote',
            attrs: { id, kind, text: def?.text ?? '', content: def?.content ?? [] },
          });
          para.hasNote = true;
          break;
        }
        case 'w:drawing':
        case 'w:pict':
        case 'w:object':
          {
            const docPr = findDesc(c, 'wp:docPr');
            const alt =
              docPr?.attrs['descr'] || docPr?.attrs['title'] || docPr?.attrs['name'] || '';
            para.inline.push({ type: 'image', attrs: { alt } });
            sawText = true;
            ctx.report.add(
              'warning',
              'image',
              'Image/object replaced with a placeholder (re-insert it after import)',
              alt || sample(),
            );
          }
          break;
        default:
          break;
      }
    }
  };

  const walk = (el: XmlElement, extra: Mark[], deleted: boolean) => {
    for (const c of kids(el)) {
      switch (c.name) {
        case 'w:pPr':
          break;
        case 'w:r':
          walkRun(c, extra, deleted);
          break;
        case 'w:ins':
        case 'w:del': {
          let raw = c.attrs['w:id'];
          if (!raw || ctx.suggestions.has(`docx-${raw}`)) {
            ctx.report.add(
              'warning',
              'duplicate_id',
              `Tracked change with ${raw ? 'duplicate' : 'missing'} id given a new id`,
              raw ?? '',
            );
            raw = ctx.freshId();
          }
          const attrs = {
            id: `docx-${raw}`,
            author: c.attrs['w:author'] ?? 'Unknown',
            ts: c.attrs['w:date'] ?? '',
          };
          ctx.suggestions.add(attrs.id);
          const type = c.name === 'w:ins' ? 'suggestion_insert' : 'suggestion_delete';
          walk(c, [...extra, { type, attrs }], deleted || c.name === 'w:del');
          break;
        }
        case 'w:commentRangeStart': {
          const orig = c.attrs['w:id'] ?? '';
          // Duplicate ids pair up with comments.xml entries in document order.
          const st = ctx.story;
          // A range continued in a later paragraph (our own export writes one
          // start/end pair per paragraph) reuses the id once the previous
          // range for it has closed, when there is a single definition.
          const prev = ctx.lastCommentId.get(orig);
          const continued =
            !!orig &&
            prev !== undefined &&
            (ctx.commentDefCount.get(orig) ?? 0) <= 1 &&
            !st.open.has(prev);
          const queued = continued ? undefined : ctx.commentIds.get(orig)?.shift();
          const id = continued
            ? prev
            : (queued ?? (!orig || ctx.usedComments.has(orig) ? ctx.freshId() : orig));
          if (id !== orig && !continued && !ctx.commentRemapped.has(id))
            ctx.report.add(
              'warning',
              'duplicate_id',
              `Comment with ${orig ? 'duplicate' : 'missing'} id given a new id`,
              ctx.commentDetail(orig, id),
            );
          ctx.lastCommentId.set(orig, id);
          ctx.anchorOrig.set(id, orig);
          ctx.startedComments.add(orig);
          st.open.add(id);
          if (!continued) st.empty.add(id);
          st.starts.set(id, st.paras.length);
          ctx.usedComments.add(id);
          const open = st.openMap.get(orig) ?? [];
          open.push(id);
          st.openMap.set(orig, open);
          break;
        }
        case 'w:commentRangeEnd': {
          const st = ctx.story;
          const id = st.openMap.get(c.attrs['w:id'] ?? '')?.shift();
          if (!id) {
            ctx.report.add(
              'warning',
              'unmatched_comment_end',
              'Comment range end without a matching start in the same story was ignored',
              ctx.commentDetail(c.attrs['w:id'] ?? ''),
            );
            break;
          }
          st.open.delete(id);
          // Zero-width (point) comment: anchor on the next text.
          if (st.empty.delete(id)) {
            st.pending.add(id);
            ctx.pointAnchors.add(id);
          }
          break;
        }
        case 'w:hyperlink':
          ctx.report.add('info', 'hyperlink', 'Hyperlinks imported as plain text', textOf(c));
          walk(c, extra, deleted);
          break;
        case 'w:moveFrom':
          walk(c, extra, true);
          break;
        case 'w:smartTag':
        case 'w:sdt':
        case 'w:sdtContent':
        case 'w:fldSimple':
        case 'w:customXml':
        case 'w:moveTo':
        case 'w:bdo':
        case 'w:dir':
          walk(c, extra, deleted);
          break;
        case 'm:oMath':
        case 'm:oMathPara':
          ctx.report.add('warning', 'math', 'Equations are not supported and were dropped');
          break;
        default:
          break;
      }
    }
  };
  walk(p, [], false);

  // Normalise typed indents: leading tabs / runs of spaces at paragraph start.
  const first = para.inline.find((n) => n.type === 'text' && n.text.length > 0);
  if (first && first.type === 'text' && /^[\t ]{2,}|^\t/.test(first.text)) {
    first.text = first.text.replace(/^[\t ]+/, '');
    ctx.report.add('info', 'typed_indent', 'Typed indent (tab/spaces) removed; theme indents');
  }
  para.text = para.text.replace(/^[\t ]+/, '');
  para.inline = normalizeInline(para.inline);
  const st = ctx.story;
  if (st.pending.size) {
    const last = [...para.inline].reverse().find((n) => n.type === 'text');
    if (last && last.type === 'text') {
      last.marks = [...(last.marks ?? []), ...[...st.pending].map(anchor)];
      st.pending.clear();
    }
  }
  st.paras.push(para.inline);
  if (!sawText) {
    para.allBold = false;
    para.allItalic = false;
  }
  return para;
}

function collectParagraphs(body: XmlElement, ctx: Ctx): Para[] {
  const out: Para[] = [];
  const walk = (el: XmlElement) => {
    for (const c of kids(el)) {
      if (c.name === 'w:p') out.push(extractParagraph(c, ctx));
      else if (c.name === 'w:tbl') {
        ctx.report.add(
          'warning',
          'table',
          'Table flattened to paragraphs (one paragraph per cell paragraph)',
        );
        for (const row of kids(c, 'w:tr')) for (const cell of kids(row, 'w:tc')) walk(cell);
      } else if (c.name === 'w:sdt' || c.name === 'w:sdtContent' || c.name === 'w:customXml')
        walk(c);
    }
  };
  walk(body);
  return out;
}

// ---------------------------------------------------------------------------
// Classification

type Role =
  | { kind: 'part' | 'chapter' | 'back'; weak?: boolean }
  | { kind: 'scene_break'; marker: string }
  | { kind: 'empty' }
  | { kind: 'separator' }
  | { kind: 'heading'; level: number }
  | { kind: 'text' };

function isEmpty(p: Para): boolean {
  return p.text.trim() === '' && !p.hasNote && !p.inline.some((n) => n.type === 'image');
}

function classify(p: Para, report: ReportBuilder): Role {
  const text = p.text.replace(/\s+/g, ' ').trim();
  const sid = p.styleId.toLowerCase();
  if (sid === 'scenebreak') return { kind: 'scene_break', marker: text };
  if (isEmpty(p)) {
    if (p.level > 0) report.add('info', 'empty_heading', 'Empty heading paragraph ignored');
    return p.breakBefore || p.breakAfter ? { kind: 'separator' } : { kind: 'empty' };
  }
  if (sid === 'parttitle') return { kind: 'part' };
  if (sid === 'backmattertitle') return { kind: 'back' };
  const short = text.length <= 80 && !/\n/.test(p.text.trim());
  const display = p.centered || p.maxSize >= 28 || p.level === 1;
  if (short && (p.level === 1 || display) && BACK_MATTER_RE.test(text)) return { kind: 'back' };
  if (short && (display || p.level > 0) && PART_RE.test(text)) return { kind: 'part' };
  if (short && CHAPTER_RE.test(text)) {
    if (display || p.level > 0) return { kind: 'chapter' };
    if (p.allBold) return { kind: 'chapter', weak: true };
  }
  if (p.level === 1) return { kind: 'chapter' };
  if (p.level > 1) return { kind: 'heading', level: p.level };
  if (text.length <= 12 && SCENE_BREAK_RE.test(text.replace(/\s+/g, '')))
    return { kind: 'scene_break', marker: text };
  return { kind: 'text' };
}

function paragraphStyle(p: Para, firstInScene: boolean, report: ReportBuilder): ParagraphStyle {
  const sid = p.styleId.toLowerCase();
  const mapped = PARA_STYLES[sid];
  if (!KNOWN_PARA_STYLES.has(sid) && p.level === 0)
    report.add(
      'warning',
      'unmapped_paragraph_style',
      `Unmapped paragraph style "${p.styleName}" imported as body text`,
      p.text.trim().slice(0, 40),
    );
  if (mapped) return mapped;
  if (p.indLeft >= 720 && p.indRight >= 720) {
    report.add(
      'info',
      'indent_block_quote',
      'Indented paragraph (both sides) mapped to block quote',
    );
    return 'block_quote';
  }
  if (p.centered) return 'centered';
  return firstInScene ? 'first' : 'body';
}

// ---------------------------------------------------------------------------
// Assembly

function corePropertyTitle(pkg: Pkg): string | undefined {
  const core = pkg.read('docProps/core.xml');
  if (!core) return undefined;
  const walk = (el: XmlElement): string | undefined => {
    for (const c of kids(el)) {
      if (typeof c === 'string') continue;
      if (c.name === 'dc:title') {
        const t = textOf(c).trim();
        if (t) return t;
      }
      const hit = walk(c);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(core);
}

/** First short, display-style line before the main body (centered / large / bold title line). */
function prominentFrontTitle(paras: Para[], endIndex: number): string | undefined {
  for (let i = 0; i < endIndex; i++) {
    const p = paras[i]!;
    const text = p.text.replace(/\s+/g, ' ').trim();
    if (!text || isEmpty(p)) continue;
    if (/^(contents|table of contents)$/i.test(text)) continue;
    if (/©|\bcopyright\b|all rights reserved/i.test(text)) continue;
    const display = p.centered || p.maxSize >= 28 || (p.allBold && text.length <= 80);
    if (
      display &&
      text.length <= 120 &&
      !CHAPTER_RE.test(text) &&
      !BACK_MATTER_RE.test(text) &&
      !PART_RE.test(text)
    )
      return text;
    if (!display && text.length > 80) break;
  }
  return undefined;
}

function resolveImportedTitle(
  paras: Para[],
  sections: ImportedSection[],
  bodyStart: number,
  pkg: Pkg,
  fileNameStem?: string,
): string {
  const styleTitle = paras.find((p) => p.styleId.toLowerCase() === 'title')?.text.trim();
  if (styleTitle) return styleTitle;
  const titlePage = sections.find((s) => s.title === 'Title Page');
  const tp = (titlePage?.content.content ?? []).map((b) =>
    'content' in b ? plainText(b.content).trim() : '',
  );
  if (tp[0]) return tp[0]!;
  const core = corePropertyTitle(pkg);
  if (core) return core;
  const prominent = prominentFrontTitle(paras, bodyStart);
  if (prominent) return prominent;
  const stem = fileNameStem?.trim();
  if (stem) return stem;
  return 'Untitled';
}

function frontMatterTitle(paras: Para[], index: number): string {
  const texts = paras.map((p) => p.text.trim());
  const joined = texts.join(' ');
  if (/^(contents|table of contents)$/i.test(texts[0] ?? '')) return 'Contents';
  if (/©|\bcopyright\b|all rights reserved/i.test(joined)) return 'Copyright';
  if (FRONT_TITLE_RE.test(texts[0] ?? '')) return texts[0]!;
  if (
    paras.every((p) => p.allItalic || /^[—–-]/.test(p.text.trim())) &&
    paras.some((p) => p.allItalic)
  )
    return paras.some((p) => /^[—–-]/.test(p.text.trim())) ? 'Epigraph' : 'Dedication';
  return index === 0 ? 'Title Page' : 'Front Matter';
}

export function importDocx(bytes: Uint8Array, options: ImportOptions = {}): ImportedManuscript {
  const manuscriptId = options.manuscriptId ?? 'imported';
  const pkg = openPackage(bytes);
  const rels = relTargets(pkg);
  const docPath = 'word/document.xml';
  const document = pkg.read(docPath);
  if (!document) throw new Error('Not a Word document: word/document.xml missing');
  const body = child(document, 'w:body');
  if (!body) throw new Error('word/document.xml has no body');

  const report = new ReportBuilder();
  const read = (type: string, fallback: string) =>
    pkg.read(rels.get(type) ?? fallback) ?? pkg.read(fallback);
  const commentDefs = new Map<string, { author: string; date: string; body: string }>();
  const ctx: Ctx = {
    styles: readStyles(pkg),
    footnotes: new Map(),
    endnotes: new Map(),
    report,
    story: newStory(),
    startedComments: new Set(),
    usedComments: new Set(),
    commentIds: new Map(),
    commentRemapped: new Set(),
    commentDefCount: new Map(),
    lastCommentId: new Map(),
    anchorOrig: new Map(),
    pointAnchors: new Set(),
    commentDetail: (orig, id) => {
      const body = (commentDefs.get(id ?? orig) ?? commentDefs.get(orig))?.body ?? '';
      const snip = body.replace(/\s+/g, ' ').slice(0, 40);
      return `${orig || '(no id)'}${snip ? `: ${snip}` : ''}`;
    },
    freshId: (() => {
      let n = 1_000_000;
      return () => String(++n);
    })(),
    suggestions: new Set(),
  };
  for (const c of kids(read('comments', 'word/comments.xml'), 'w:comment')) {
    const orig = c.attrs['w:id'] ?? '';
    ctx.commentDefCount.set(orig, (ctx.commentDefCount.get(orig) ?? 0) + 1);
    let id = orig;
    if (!orig || commentDefs.has(orig)) {
      id = ctx.freshId();
      ctx.commentRemapped.add(id);
      report.add(
        'warning',
        'duplicate_id',
        `Comment with ${orig ? 'duplicate' : 'missing'} id given a new id`,
        `${orig || '(no id)'}: ${kids(c, 'w:p').map(textOf).join(' ').trim().slice(0, 40)}`,
      );
    }
    const q = ctx.commentIds.get(orig) ?? [];
    q.push(id);
    ctx.commentIds.set(orig, q);
    commentDefs.set(id, {
      author: c.attrs['w:author'] ?? 'Unknown',
      date: c.attrs['w:date'] ?? '',
      body: kids(c, 'w:p')
        .map((p) => textOf(p))
        .join('\n')
        .trim(),
    });
  }
  ctx.footnotes = readNotes(read('footnotes', 'word/footnotes.xml'), 'w:footnote', ctx);
  ctx.endnotes = readNotes(read('endnotes', 'word/endnotes.xml'), 'w:endnote', ctx);
  for (const kind of ['header', 'footer'])
    for (const target of relAll(pkg, kind))
      report.add(
        'warning',
        'header_footer',
        `${kind === 'header' ? 'Header' : 'Footer'} dropped on purpose (book design generates running heads and page numbers)`,
        target,
      );

  ctx.story = newStory();
  const paras = collectParagraphs(body, ctx);
  finishStory(ctx);
  const roles = paras.map((p) => classify(p, report));
  for (const [i, r] of roles.entries())
    if (r.kind === 'chapter' && r.weak)
      report.add(
        'warning',
        'ambiguous_chapter',
        'Plain bold "Chapter N" line treated as a chapter title; please confirm',
        paras[i]!.text.trim(),
      );

  const sections: ImportedSection[] = [];
  let seq = 0;
  const newSection = (kind: SectionKind, title: string, parentId?: string): ImportedSection => {
    const id = `s${String(++seq).padStart(3, '0')}`;
    const s: ImportedSection = {
      id,
      kind,
      title,
      docId: sectionDocId(manuscriptId, id),
      content: { type: 'doc', content: [] },
    };
    if (parentId) s.parentId = parentId;
    sections.push(s);
    return s;
  };

  const firstStructural = roles.findIndex(
    (r) => r.kind === 'part' || r.kind === 'chapter' || r.kind === 'back',
  );
  const hasChapters = roles.some((r) => r.kind === 'chapter');
  const bodyStart = hasChapters ? Math.max(firstStructural, 0) : 0;

  // Front matter: page-separated groups before the first part/chapter.
  if (hasChapters && bodyStart > 0) {
    let group: Para[] = [];
    let groupIndex = 0;
    const flush = () => {
      const content = group.filter((p) => !isEmpty(p));
      if (content.length) {
        const s = newSection('front_matter', frontMatterTitle(content, groupIndex++));
        const epigraph = s.title === 'Epigraph';
        s.content.content = content.map((p) => ({
          type: 'paragraph',
          attrs: {
            style: epigraph && p.centered ? 'epigraph' : paragraphStyle(p, false, report),
          },
          ...(p.inline.length ? { content: p.inline } : {}),
        }));
      }
      group = [];
    };
    for (let i = 0; i < bodyStart; i++) {
      const p = paras[i]!;
      if (p.breakBefore) flush();
      if (!isEmpty(p)) group.push(p);
      else if (!p.breakBefore && !p.breakAfter)
        report.add('info', 'spacing', 'Empty spacing paragraphs removed');
      if (p.breakAfter) flush();
    }
    flush();
  }

  if (!hasChapters)
    report.add(
      'warning',
      'no_chapters',
      'No chapter headings found; imported as a single chapter. Split it in the outline.',
    );

  let part: ImportedSection | undefined;
  let chapter: ImportedSection | undefined;
  let back: ImportedSection | undefined;
  let chapterHasBody = false;
  let blanks = 0;
  let pendingPageBreak = false;
  let sceneBreaks = 0;

  const appendSceneBreak = (marker: string) => {
    if (!chapter) return;
    chapter.content.content.push({ type: 'scene_break', attrs: { marker } });
    sceneBreaks++;
    chapterHasBody = false;
  };
  const target = (): ImportedSection => {
    if (back) return back;
    if (chapter) return chapter;
    if (part) return part;
    chapter = newSection('chapter', 'Untitled');
    return chapter;
  };
  const titleBlock = (p: Para, level: number): BlockNode => ({
    type: 'heading',
    attrs: { level },
    ...(p.inline.length ? { content: p.inline } : {}),
  });

  for (let i = bodyStart; i < paras.length; i++) {
    const p = paras[i]!;
    const role = roles[i]!;
    const title = p.text.replace(/\s+/g, ' ').trim();
    if (p.breakBefore && role.kind !== 'separator') pendingPageBreak = true;
    switch (role.kind) {
      case 'separator':
        pendingPageBreak = true;
        blanks = 0;
        break;
      case 'empty':
        if (chapterHasBody || back) blanks++;
        else report.add('info', 'spacing', 'Empty spacing paragraphs removed');
        break;
      case 'part':
        part = newSection('part', title);
        part.content.content.push(titleBlock(p, 1));
        chapter = back = undefined;
        pendingPageBreak = false;
        chapterHasBody = false;
        blanks = 0;
        break;
      case 'chapter':
        chapter = newSection('chapter', title, part?.id);
        chapter.content.content.push(titleBlock(p, 1));
        back = undefined;
        pendingPageBreak = false;
        chapterHasBody = false;
        blanks = 0;
        break;
      case 'back':
        back = newSection('back_matter', title);
        back.content.content.push(titleBlock(p, 1));
        part = chapter = undefined;
        pendingPageBreak = false;
        chapterHasBody = false;
        blanks = 0;
        break;
      case 'scene_break':
        blanks = 0;
        if (back)
          back.content.content.push({ type: 'scene_break', attrs: { marker: role.marker } });
        else if (chapter && chapterHasBody) appendSceneBreak(role.marker);
        else report.add('info', 'leading_break', 'Scene break before any text ignored');
        break;
      case 'heading':
      case 'text': {
        if (blanks >= 2 && chapterHasBody && chapter && !back) appendSceneBreak('');
        else if (blanks === 1 && chapterHasBody && chapter && !back)
          report.add(
            'warning',
            'single_blank_line',
            'Single blank line inside a chapter kept as spacing, not a scene break (check if a break was intended)',
            title.slice(0, 40),
          );
        else if (blanks > 0) report.add('info', 'spacing', 'Empty spacing paragraphs removed');
        blanks = 0;
        const t = target();
        if (pendingPageBreak && t.content.content.length)
          t.content.content.push({ type: 'page_break' });
        pendingPageBreak = false;
        if (role.kind === 'heading') {
          report.add('info', 'subheading', `Heading ${role.level} kept as a subheading`, title);
          t.content.content.push(titleBlock(p, role.level));
        } else {
          const first = t === chapter && !chapterHasBody;
          const style = paragraphStyle(p, first, report);
          t.content.content.push({
            type: 'paragraph',
            attrs: { style },
            ...(p.inline.length ? { content: p.inline } : {}),
          });
          const lines = plainText(p.inline).split('\n');
          if (
            lines.length > 1 &&
            lines.some(
              (l) => CHAPTER_RE.test(l.trim()) || SCENE_BREAK_RE.test(l.replace(/\s+/g, '')),
            )
          )
            report.add(
              'warning',
              'soft_break_structure',
              'Chapter or scene marker inside a paragraph with line breaks was not split',
              title,
            );
        }
        if (t === chapter) chapterHasBody = true;
        break;
      }
    }
    if (p.breakAfter) pendingPageBreak = true;
  }
  const doc = { sections };

  // Orphan anchors: a commentRangeStart/End id with no comments.xml entry. Drop the mark
  // (there is no comment behind it) and say so, with the id and the text it covered.
  const orphanText = new Map<string, string>();
  const stripOrphans = (nodes: unknown[] | undefined): void => {
    for (const n of nodes ?? []) {
      const node = n as {
        type?: string;
        text?: string;
        marks?: Mark[];
        content?: unknown[];
        attrs?: { content?: unknown[] };
      };
      if (node.marks?.length) {
        node.marks = node.marks.filter((m) => {
          if (m.type !== 'comment_anchor') return true;
          const id = String((m.attrs as { id?: unknown } | undefined)?.id ?? '');
          if (commentDefs.has(id)) return true;
          const prev = orphanText.get(id) ?? '';
          if (prev.length < 40) orphanText.set(id, prev + (node.text ?? ''));
          return false;
        });
        if (!node.marks.length) delete node.marks;
      }
      stripOrphans(node.content);
      // Footnote and endnote bodies live in attrs.content.
      if (Array.isArray(node.attrs?.content)) stripOrphans(node.attrs.content);
    }
  };
  for (const s of doc.sections) stripOrphans(s.content.content);
  for (const [id, snippet] of orphanText) {
    // A point anchor covers text only because we attached it to the next run; it had none.
    const shown = ctx.pointAnchors.has(id) ? '' : snippet.trim().slice(0, 40);
    report.add(
      'warning',
      'orphan_anchor',
      'Comment range had no matching comment; the empty anchor was removed',
      `${ctx.anchorOrig.get(id) || id}: ${shown || '(no text)'}`,
    );
  }

  // Comments: attach to the section whose content carries the anchor mark.
  const comments: ImportedComment[] = [];
  for (const [id, def] of commentDefs) {
    const owner = doc.sections.find((s) =>
      JSON.stringify(s.content).includes(`"comment_anchor","attrs":{"id":${JSON.stringify(id)}}`),
    );
    if (owner) {
      comments.push({ id, sectionId: owner.id, ...def });
      continue;
    }
    // No anchor in the text: keep the body, anchored at the first text we have.
    let host: (typeof doc.sections)[number] | undefined;
    for (const s of doc.sections) {
      const first = s.content.content
        .flatMap((b) => ('content' in b ? (b.content ?? []) : []))
        .find((n) => n.type === 'text');
      if (first && first.type === 'text') {
        first.marks = [...(first.marks ?? []), anchor(id)];
        host = s;
        break;
      }
    }
    host ??= doc.sections[0];
    if (!host) {
      report.add(
        'warning',
        'orphan_comment',
        'Comment could not be anchored: the document has no text (body shown here)',
        `${id}: ${def.body || '(empty comment)'}`,
      );
      continue;
    }
    report.add(
      'warning',
      'orphan_comment',
      `Comment had no anchor in the text; kept and attached to the start of section "${host.title}"`,
      `${id}: ${def.body.slice(0, 40)}`,
    );
    comments.push({ id, sectionId: host.id, ...def });
  }

  const count = (k: SectionKind) => doc.sections.filter((s) => s.kind === k).length;
  const fullReport: ImportReport = {
    summary: {
      frontMatter: count('front_matter'),
      parts: count('part'),
      chapters: hasChapters ? count('chapter') : 0,
      scenes: 0,
      sceneBreaks,
      backMatter: count('back_matter'),
      footnotes: JSON.stringify(doc.sections).split('"type":"footnote"').length - 1,
      comments: comments.length,
      suggestions: ctx.suggestions.size,
      paragraphs: paras.length,
    },
    items: report.list(),
  };

  const titlePage = doc.sections.find((s) => s.title === 'Title Page');
  const tp = (titlePage?.content.content ?? []).map((b) =>
    'content' in b ? plainText(b.content).trim() : '',
  );
  const result: ImportedManuscript = {
    title: resolveImportedTitle(paras, doc.sections, bodyStart, pkg, options.fileNameStem),
    sections: doc.sections,
    comments,
    report: fullReport,
    warnings: fullReport.items.filter((i) => i.level === 'warning').map((i) => i.message),
  };
  const author = tp.find((t, i) => i > 0 && t && !/^a novel$/i.test(t));
  if (author) result.author = author.replace(/^by\s+/i, '');
  return result;
}

function findDesc(el: XmlElement, name: string): XmlElement | undefined {
  for (const c of kids(el)) {
    if (c.name === name) return c;
    const hit = findDesc(c, name);
    if (hit) return hit;
  }
  return undefined;
}
