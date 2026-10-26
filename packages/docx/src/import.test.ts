import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  docToYDoc,
  exportDocx,
  formatReport,
  importDocx,
  manuscriptToYDocs,
  plainText,
  yDocToDoc,
  type BlockNode,
  type ImportedManuscript,
  type ImportedSection,
  type InlineNode,
} from './index';

const dir = fileURLToPath(new URL('../../../fixtures/manuscripts/docx-import/', import.meta.url));
const load = (name: string) => importDocx(readFileSync(dir + name), { manuscriptId: 'm1' });

/** Ground truth parsed from EXPECTED.md so the test tracks the fixture spec. */
function expected() {
  const md = readFileSync(dir + 'EXPECTED.md', 'utf8');
  const parts: {
    title: string;
    chapters: { title: string; scenes: number; breaks: string[] }[];
  }[] = [];
  for (const line of md.split('\n')) {
    const part = /^### (Part .+?)\s+\(/.exec(line);
    if (part) parts.push({ title: part[1]!, chapters: [] });
    const ch = /^- Ch \d+: `(.+?)` \[\w+\] — (\d+) scenes; breaks: (.+)$/.exec(line);
    if (ch)
      parts[parts.length - 1]!.chapters.push({
        title: ch[1]!,
        scenes: Number(ch[2]),
        breaks: [...ch[3]!.matchAll(/'([^']+)'/g)].map((m) => (m[1] === 'BLANK2' ? '' : m[1]!)),
      });
  }
  const total = Number(/Total scene breaks: (\d+)/.exec(md)?.[1]);
  return { parts, total };
}

const blocks = (m: ImportedManuscript, kind: string) => m.sections.filter((s) => s.kind === kind);
const childrenOf = (m: ImportedManuscript, s: ImportedSection) =>
  m.sections.filter((c) => c.parentId === s.id);
const allInline = (s: ImportedSection): InlineNode[] =>
  s.content.content.flatMap((b: BlockNode) => ('content' in b ? (b.content ?? []) : []));
const text = (s: ImportedSection) =>
  s.content.content.map((b) => ('content' in b ? plainText(b.content) : '')).join('\n');

describe('mock-manuscript.docx vs EXPECTED.md', () => {
  const m = load('mock-manuscript.docx');
  const exp = expected();

  it('reads title and author from the title page', () => {
    expect(m.title).toBe('THE LANTERNS OF HOLLOW REACH');
    expect(m.author).toBe('Rowan Ashby Vale');
  });

  it('detects the five front matter pages in order (TOC is not chapters)', () => {
    expect(blocks(m, 'front_matter').map((s) => s.title)).toEqual([
      'Title Page',
      'Copyright',
      'Dedication',
      'Epigraph',
      'Contents',
    ]);
    const epigraph = blocks(m, 'front_matter')[3]!;
    expect(
      epigraph.content.content.every((b) => b.type === 'paragraph' && b.attrs.style === 'epigraph'),
    ).toBe(true);
  });

  it('detects parts, chapters, scene counts and break markers', () => {
    expect(exp.parts).toHaveLength(3);
    const parts = blocks(m, 'part');
    expect(parts.map((p) => p.title)).toEqual(exp.parts.map((p) => p.title));
    exp.parts.forEach((ep, i) => {
      const chapters = childrenOf(m, parts[i]!);
      expect(chapters.map((c) => c.title)).toEqual(ep.chapters.map((c) => c.title));
      ep.chapters.forEach((ec, j) => {
        const scenes = childrenOf(m, chapters[j]!);
        expect(scenes, ec.title).toHaveLength(ec.scenes);
        const markers = scenes.slice(1).map((s) => {
          const first = s.content.content[0];
          return first?.type === 'scene_break' ? first.attrs.marker : '(missing)';
        });
        expect(markers, ec.title).toEqual(ec.breaks);
        expect(scenes[0]!.content.content[0]?.type, ec.title).toBe('paragraph');
      });
    });
    expect(blocks(m, 'chapter')).toHaveLength(12);
    expect(m.report.summary.sceneBreaks).toBe(exp.total);
  });

  it('treats Acknowledgments as back matter, not chapter 13', () => {
    expect(blocks(m, 'back_matter').map((s) => s.title)).toEqual(['Acknowledgments']);
    expect(m.report.summary.chapters).toBe(12);
  });

  it('keeps inline formatting, block quotes, tracked changes, footnote and comment', () => {
    const last = childrenOf(m, blocks(m, 'chapter')[11]!).at(-1)!;
    const inl = allInline(last);
    const marked = (t: string, type: string) =>
      inl.some(
        (n) => n.type === 'text' && n.text.includes(t) && n.marks?.some((k) => k.type === type),
      );
    expect(marked('the keeper’s knot', 'smallcaps')).toBe(true);
    expect(marked('not', 'bold')).toBe(true);
    expect(marked('CASS:', 'smallcaps') && marked('CASS:', 'bold')).toBe(true);
    expect(marked(' Twice.', 'suggestion_insert')).toBe(true);
    expect(marked(' Once was never enough.', 'suggestion_delete')).toBe(true);
    expect(marked('Fenwick swore the lamp', 'comment_anchor')).toBe(true);
    const fn = inl.find((n) => n.type === 'footnote');
    expect(fn && fn.type === 'footnote' && fn.attrs.id).toBe('1');
    expect(fn && fn.type === 'footnote' && fn.attrs.text).toMatch(/^The Reach Light was/);
    const styles = last.content.content.flatMap((b) =>
      b.type === 'paragraph' ? [b.attrs.style] : [],
    );
    expect(styles.filter((s) => s === 'block_quote')).toHaveLength(2); // letter + Quote style
    expect(text(last)).toContain('🕯');
    expect(m.comments).toEqual([
      expect.objectContaining({ id: '0', sectionId: last.id, author: 'Fixture Editor' }),
    ]);
    const s = m.report.summary;
    expect([s.footnotes, s.comments, s.suggestions]).toEqual([1, 1, 2]);
  });

  it('keeps manual line breaks and strips typed indents', () => {
    const all = m.sections.flatMap(allInline);
    expect(all.some((n) => n.type === 'hard_break')).toBe(true);
    for (const s of blocks(m, 'scene'))
      for (const b of s.content.content)
        if (b.type === 'paragraph') expect(plainText(b.content)).not.toMatch(/^[\t ]/);
  });

  it('produces a report that flags what was dropped', () => {
    const codes = m.report.items.map((i) => i.code);
    expect(codes).toContain('direct_font');
    expect(codes).toContain('header_footer');
    expect(m.report.items.filter((i) => i.level === 'warning')).toEqual([]);
    expect(formatReport(m.report)).toContain('- Chapters: 12');
  });

  it('gives every section its own Yjs doc that round-trips', () => {
    const docs = manuscriptToYDocs(m);
    expect(docs.size).toBe(m.sections.length);
    expect(new Set(m.sections.map((s) => s.docId)).size).toBe(m.sections.length);
    for (const s of m.sections) expect(yDocToDoc(docs.get(s.docId)!)).toEqual(s.content);
  });
});

describe('edge cases', () => {
  it('edge-no-headings: no invented chapters, single fallback chapter', () => {
    const m = load('edge-no-headings.docx');
    expect(m.report.summary.chapters).toBe(0);
    expect(blocks(m, 'chapter')).toHaveLength(1);
    expect(m.report.items.map((i) => i.code)).toContain('no_chapters');
    expect(
      blocks(m, 'scene')[0]!.content.content.filter((b) => b.type === 'paragraph'),
    ).toHaveLength(3);
  });

  it('edge-false-positives: only real chapter markers, ambiguous one flagged', () => {
    const m = load('edge-false-positives.docx');
    expect(blocks(m, 'chapter').map((c) => c.title)).toEqual(['Chapter One', 'CHAPTER TWO']);
    expect(m.report.items.find((i) => i.code === 'ambiguous_chapter')?.samples).toEqual([
      'CHAPTER TWO',
    ]);
    const body = m.sections.map(text).join('\n');
    expect(body).toContain('Chapter 2 was mentioned in passing');
    expect(body).toContain('***  not a break because it has trailing words');
    expect(body).toContain('Notes to self');
    expect(m.report.summary.sceneBreaks).toBe(0);
  });

  it('edge-soft-breaks-only: preserves text and line breaks', () => {
    const m = load('edge-soft-breaks-only.docx');
    const all = m.sections.map(text).join('\n');
    for (const t of ['Chapter 1', 'Ünïcödé — “quotes” ‘single’ … ellipsis', '* * *', 'Next scene'])
      expect(all).toContain(t);
    expect(m.sections.flatMap(allInline).filter((n) => n.type === 'hard_break')).toHaveLength(5);
    expect(m.report.items.map((i) => i.code)).toContain('soft_break_structure');
  });

  it('flags unmapped paragraph and character styles', () => {
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const docx = zipSync({
      'word/document.xml': strToU8(
        `<w:document xmlns:w="${W}"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>One</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Fancy"/></w:pPr><w:r><w:rPr><w:rStyle w:val="Glow"/><w:u w:val="single"/></w:rPr><w:t>Hello &amp; welcome</w:t></w:r></w:p></w:body></w:document>`,
      ),
      'word/styles.xml': strToU8(
        `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Fancy"><w:name w:val="Fancy Body"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`,
      ),
    });
    const m = importDocx(docx);
    expect(m.warnings).toEqual(
      expect.arrayContaining([
        'Unmapped paragraph style "Fancy Body" imported as body text',
        'Unmapped character style "Glow"',
        'Underline is not supported and was dropped',
      ]),
    );
    expect(text(blocks(m, 'scene')[0]!)).toBe('Hello & welcome');
  });
});

describe('.docx round trip', () => {
  const strip = (m: ImportedManuscript) => ({
    title: m.title,
    author: m.author,
    sections: m.sections.map(({ id, kind, title, parentId, content }) => ({
      id,
      kind,
      title,
      parentId,
      content,
    })),
    comments: m.comments,
  });

  for (const f of [
    'mock-manuscript.docx',
    'edge-false-positives.docx',
    'edge-no-headings.docx',
    'edge-soft-breaks-only.docx',
  ])
    it(`${f}: import -> export -> import is lossless`, () => {
      const a = load(f);
      const b = importDocx(exportDocx(a), { manuscriptId: 'm1' });
      const sa = strip(a);
      const sb = strip(b);
      if (a.report.summary.chapters === 0) {
        // Fallback chapter is untitled and stays a fallback.
        expect(b.report.summary.chapters).toBe(0);
      }
      expect(sb).toEqual(sa);
      expect(b.report.summary.sceneBreaks).toBe(a.report.summary.sceneBreaks);
    });

  it('exported doc converts to Yjs and back', () => {
    const a = load('mock-manuscript.docx');
    const s = a.sections.find((x) => x.kind === 'scene')!;
    expect(yDocToDoc(docToYDoc(s.content))).toEqual(s.content);
  });
});
