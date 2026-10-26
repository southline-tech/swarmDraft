/**
 * .docx -> structured manuscript importer (RAD-218).
 *
 * Reads the OOXML parts directly (no external converter) so we keep full
 * control over the signals that matter for a finished novel manuscript:
 * direct formatting used as headings, several scene-break conventions,
 * tracked changes, comments and footnotes.
 */
import { unzipSync, strFromU8 } from 'fflate';
import { sectionDocId, type SectionKind } from '@coauthor/schema';
import { child, kids, onOff, parseXml, textOf, val, type XmlElement } from './xml';
import {
  normalizeInline,
  plainText,
  type BlockNode,
  type DocNode,
  type InlineNode,
  type Mark,
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
}

// ---------------------------------------------------------------------------
// Patterns

const NUMBER_WORDS =
  'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred';
const NUM = `(?:\\d+|[ivxlcdm]+|(?:(?:${NUMBER_WORDS})[\\s-]*)+)`;
const CHAPTER_RE = new RegExp(`^(?:chapter|ch\\.)\\s+${NUM}\\s*(?:[:.\\-–—]\\s*\\S.*)?$`, 'i');
const PART_RE = new RegExp(`^(?:part|book)\\s+${NUM}\\s*(?:[:.\\-–—]\\s*\\S.*)?$`, 'i');
const BACK_MATTER_RE =
  /^(acknowledge?ments?|about the author|afterword|author'?s note|author’s note|glossary|also by .+|reading group guide|discussion questions|notes|bibliography|appendix\b.*)$/i;
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

function openPackage(bytes: Uint8Array): Pkg {
  const files = unzipSync(bytes);
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

function noteTexts(root: XmlElement | undefined, tag: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of kids(root, tag)) {
    if (n.attrs['w:type'] && n.attrs['w:type'] !== 'normal') continue;
    const paras = kids(n, 'w:p').map((p) => {
      let t = '';
      const walk = (el: XmlElement) => {
        for (const c of kids(el)) {
          if (c.name === 'w:t') t += textOf(c);
          else if (c.name === 'w:tab') t += '\t';
          else if (c.name !== 'w:footnoteRef' && c.name !== 'w:endnoteRef') walk(c);
        }
      };
      walk(p);
      return t;
    });
    out.set(n.attrs['w:id'] ?? '', paras.join('\n').trim());
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

interface Ctx {
  styles: Map<string, StyleInfo>;
  footnotes: Map<string, string>;
  endnotes: Map<string, string>;
  report: ReportBuilder;
  openComments: Set<string>;
  usedComments: Set<string>;
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
  const u = val(rPr, 'w:u');
  if (u !== undefined && u !== 'none')
    ctx.report.add('warning', 'underline', 'Underline is not supported and was dropped', sample());
  if (onOff(rPr, 'w:strike') || onOff(rPr, 'w:dstrike'))
    ctx.report.add('warning', 'strike', 'Strikethrough is not supported and was dropped', sample());
  const va = val(rPr, 'w:vertAlign');
  if (va && va !== 'baseline' && !isNoteRun)
    ctx.report.add('warning', 'vert_align', `Unsupported ${va} text kept as normal text`, sample());
  if (child(rPr, 'w:rFonts') || child(rPr, 'w:sz') || child(rPr, 'w:color'))
    ctx.report.add(
      'info',
      'direct_font',
      'Direct font, size or color formatting dropped (theme controls typography)',
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
    const isNoteRun = !!(child(r, 'w:footnoteReference') || child(r, 'w:endnoteReference'));
    const marks = [...runMarks(rPr, ctx, sample, isNoteRun), ...extra];
    for (const id of ctx.openComments) marks.push({ type: 'comment_anchor', attrs: { id } });
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
        case 'w:footnoteReference':
        case 'w:endnoteReference': {
          const id = c.attrs['w:id'] ?? '';
          const notes = c.name === 'w:footnoteReference' ? ctx.footnotes : ctx.endnotes;
          const text = notes.get(id);
          if (text === undefined)
            ctx.report.add('warning', 'missing_note', `Note ${id} referenced but not found`);
          para.inline.push({ type: 'footnote', attrs: { id, text: text ?? '' } });
          para.hasNote = true;
          if (c.name === 'w:endnoteReference')
            ctx.report.add('info', 'endnote', 'Endnotes imported as footnotes');
          break;
        }
        case 'w:drawing':
        case 'w:pict':
        case 'w:object':
          ctx.report.add('warning', 'image', 'Images/objects are not imported yet', sample());
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
          const attrs = {
            id: `docx-${c.attrs['w:id'] ?? ctx.suggestions.size}`,
            author: c.attrs['w:author'] ?? 'Unknown',
            ts: c.attrs['w:date'] ?? '',
          };
          ctx.suggestions.add(attrs.id);
          const type = c.name === 'w:ins' ? 'suggestion_insert' : 'suggestion_delete';
          walk(c, [...extra, { type, attrs }], deleted || c.name === 'w:del');
          break;
        }
        case 'w:commentRangeStart':
          ctx.openComments.add(c.attrs['w:id'] ?? '');
          ctx.usedComments.add(c.attrs['w:id'] ?? '');
          break;
        case 'w:commentRangeEnd':
          ctx.openComments.delete(c.attrs['w:id'] ?? '');
          break;
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
        ctx.report.add('warning', 'table', 'Table flattened to paragraphs');
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
  return p.text.trim() === '' && !p.hasNote;
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
  const ctx: Ctx = {
    styles: readStyles(pkg),
    footnotes: noteTexts(read('footnotes', 'word/footnotes.xml'), 'w:footnote'),
    endnotes: noteTexts(read('endnotes', 'word/endnotes.xml'), 'w:endnote'),
    report,
    openComments: new Set(),
    usedComments: new Set(),
    suggestions: new Set(),
  };
  const commentDefs = new Map<string, { author: string; date: string; body: string }>();
  for (const c of kids(read('comments', 'word/comments.xml'), 'w:comment')) {
    commentDefs.set(c.attrs['w:id'] ?? '', {
      author: c.attrs['w:author'] ?? 'Unknown',
      date: c.attrs['w:date'] ?? '',
      body: kids(c, 'w:p')
        .map((p) => textOf(p))
        .join('\n')
        .trim(),
    });
  }
  if (rels.has('header') || rels.has('footer'))
    report.add('info', 'header_footer', 'Headers/footers not imported (theme generates them)');

  const paras = collectParagraphs(body, ctx);
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
  let scene: ImportedSection | undefined;
  let back: ImportedSection | undefined;
  let sceneHasText = false;
  let blanks = 0;
  let pendingPageBreak = false;
  let sceneBreaks = 0;

  const startScene = (marker?: string) => {
    if (!chapter) return;
    const n = sections.filter((s) => s.parentId === chapter!.id && s.kind === 'scene').length;
    scene = newSection('scene', `Scene ${n + 1}`, chapter.id);
    if (marker !== undefined) {
      scene.content.content.push({ type: 'scene_break', attrs: { marker } });
      sceneBreaks++;
    }
    sceneHasText = false;
  };
  const target = (): ImportedSection => {
    if (back) return back;
    if (chapter) {
      if (!scene) startScene();
      return scene!;
    }
    if (part) return part;
    chapter = newSection('chapter', 'Untitled');
    return target();
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
        if (sceneHasText || back) blanks++;
        else report.add('info', 'spacing', 'Empty spacing paragraphs removed');
        break;
      case 'part':
        part = newSection('part', title);
        part.content.content.push(titleBlock(p, 1));
        chapter = scene = back = undefined;
        pendingPageBreak = false;
        sceneHasText = false;
        blanks = 0;
        break;
      case 'chapter':
        chapter = newSection('chapter', title, part?.id);
        chapter.content.content.push(titleBlock(p, 1));
        scene = back = undefined;
        pendingPageBreak = false;
        sceneHasText = false;
        blanks = 0;
        break;
      case 'back':
        back = newSection('back_matter', title);
        back.content.content.push(titleBlock(p, 1));
        part = chapter = scene = undefined;
        pendingPageBreak = false;
        sceneHasText = false;
        blanks = 0;
        break;
      case 'scene_break':
        blanks = 0;
        if (back)
          back.content.content.push({ type: 'scene_break', attrs: { marker: role.marker } });
        else if (chapter && sceneHasText) startScene(role.marker);
        else report.add('info', 'leading_break', 'Scene break before any text ignored');
        break;
      case 'heading':
      case 'text': {
        if (blanks >= 2 && sceneHasText && chapter && !back) startScene('');
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
          const first = t.kind === 'scene' && !sceneHasText;
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
        if (t.kind === 'scene') sceneHasText = true;
        break;
      }
    }
    if (p.breakAfter) pendingPageBreak = true;
  }
  // Drop empty scenes (e.g. a chapter with no text).
  const doc = { sections: sections.filter((s) => s.kind !== 'scene' || s.content.content.length) };

  // Comments: attach to the section whose content carries the anchor mark.
  const comments: ImportedComment[] = [];
  for (const [id, def] of commentDefs) {
    const owner = doc.sections.find((s) =>
      JSON.stringify(s.content).includes(`"comment_anchor","attrs":{"id":${JSON.stringify(id)}}`),
    );
    if (!owner) {
      report.add('warning', 'orphan_comment', 'Comment without an anchor in the text was dropped');
      continue;
    }
    comments.push({ id, sectionId: owner.id, ...def });
  }

  const count = (k: SectionKind) => doc.sections.filter((s) => s.kind === k).length;
  const fullReport: ImportReport = {
    summary: {
      frontMatter: count('front_matter'),
      parts: count('part'),
      chapters: hasChapters ? count('chapter') : 0,
      scenes: count('scene'),
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
  const styleTitle = paras.find((p) => p.styleId.toLowerCase() === 'title')?.text.trim();
  const result: ImportedManuscript = {
    title: styleTitle || tp[0] || 'Untitled',
    sections: doc.sections,
    comments,
    report: fullReport,
    warnings: fullReport.items.filter((i) => i.level === 'warning').map((i) => i.message),
  };
  const author = tp.find((t, i) => i > 0 && t && !/^a novel$/i.test(t));
  if (author) result.author = author.replace(/^by\s+/i, '');
  return result;
}
