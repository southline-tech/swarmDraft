import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { MARK_TYPES, INLINE_NODE_TYPES } from '@coauthor/schema';
import {
  DOCX_LIMITS,
  docToYDoc,
  exportDocx,
  importDocx,
  readView,
  yDocToDoc,
  type FootnoteNode,
  type ImportedManuscript,
  type InlineNode,
} from './index';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const NS = `xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"`;
const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const r = (t: string, rPr = '') =>
  `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${t}</w:t></w:r>`;
const p = (inner: string, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`;

/** Synthetic document exercising formatting, notes, images, tables, headers and overlaps. */
function sample(): Uint8Array {
  const body = [
    p(r('Chapter 1'), '<w:pStyle w:val="Heading1"/>'),
    p(
      r('under', '<w:u w:val="single"/>') +
        r(' struck', '<w:strike/>') +
        r(' caps', '<w:smallCaps/><w:rFonts w:ascii="Fancy"/><w:sz w:val="40"/>') +
        r(' plain', '<w:rFonts w:ascii="Fancy"/>') +
        `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r>` +
        `<w:r><w:rPr><w:rStyle w:val="EndnoteReference"/></w:rPr><w:endnoteReference w:id="1"/></w:r>`,
    ),
    p(
      r('A ') +
        '<w:commentRangeStart w:id="1"/>' +
        r('one ') +
        '<w:commentRangeStart w:id="2"/>' +
        r('both') +
        '<w:commentRangeEnd w:id="1"/>' +
        r(' two') +
        '<w:commentRangeEnd w:id="2"/>' +
        '<w:ins w:id="7" w:author="Ann"><w:ins w:id="8" w:author="Bo">' +
        r(' added') +
        '</w:ins></w:ins>',
    ),
    p(
      `<w:r><w:drawing><wp:inline><wp:docPr w:id="1" name="Pic 1" descr="A lighthouse"/></wp:inline></w:drawing></w:r>`,
    ),
    `<w:tbl><w:tr><w:tc>${p(r('cell one'))}</w:tc><w:tc>${p(r('cell two'))}</w:tc></w:tr></w:tbl>`,
    p(''),
    p(r('After one blank line.')),
  ].join('');
  return zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8(`<w:document ${NS}><w:body>${body}</w:body></w:document>`),
    'word/_rels/document.xml.rels': strToU8(
      `<Relationships><Relationship Id="rId1" Type="${rel}/header" Target="header1.xml"/><Relationship Id="rId2" Type="${rel}/header" Target="header2.xml"/><Relationship Id="rId3" Type="${rel}/footer" Target="footer1.xml"/></Relationships>`,
    ),
    'word/styles.xml': strToU8(
      `<w:styles ${NS}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`,
    ),
    'word/footnotes.xml': strToU8(
      `<w:footnotes ${NS}><w:footnote w:id="1">${p(`<w:r><w:footnoteRef/></w:r>${r(' First ')}${r('italic', '<w:i/>')}`)}${p(r('Second paragraph.'))}</w:footnote></w:footnotes>`,
    ),
    'word/endnotes.xml': strToU8(
      `<w:endnotes ${NS}><w:endnote w:id="1">${p(`<w:r><w:endnoteRef/></w:r>${r(' An endnote.')}`)}</w:endnote></w:endnotes>`,
    ),
    'word/comments.xml': strToU8(
      `<w:comments ${NS}><w:comment w:id="1" w:author="Ann">${p(r('c1'))}</w:comment><w:comment w:id="2" w:author="Bo">${p(r('c2'))}</w:comment></w:comments>`,
    ),
    'word/media/huge.bin': new Uint8Array(1024),
  });
}

const scene = (m: ImportedManuscript) => m.sections.find((s) => s.kind === 'scene')!.content;
const inlines = (m: ImportedManuscript) =>
  scene(m).content.flatMap((b) => ('content' in b ? (b.content ?? []) : [])) as InlineNode[];

describe('formatting, notes and dropped features', () => {
  const m = importDocx(sample(), { manuscriptId: 'm1' });
  const codes = m.report.items.map((i) => i.code);

  it('maps underline, strike and small caps; ignores direct fonts on purpose', () => {
    const marks = (t: string) =>
      inlines(m)
        .flatMap((n) => (n.type === 'text' && n.text.includes(t) ? [n] : []))[0]!
        .marks?.map((x) => x.type);
    expect(marks('under')).toEqual(['underline']);
    expect(marks('struck')).toEqual(['strike']);
    expect(marks('caps')).toEqual(['smallcaps']);
    expect(marks('plain')).toBeUndefined();
    expect(codes).toContain('direct_font');
  });

  it('keeps footnote paragraphs and formatting, and endnotes separate', () => {
    const notes = inlines(m).filter((n): n is FootnoteNode => n.type === 'footnote');
    expect(notes.map((n) => n.attrs.kind)).toEqual(['footnote', 'endnote']);
    const fn = notes[0]!.attrs;
    expect(fn.content).toHaveLength(2);
    expect(fn.content[0]!.content).toEqual([
      { type: 'text', text: 'First ' },
      { type: 'text', text: 'italic', marks: [{ type: 'italic' }] },
    ]);
    expect(fn.text).toBe('First italic\nSecond paragraph.');
    expect(notes[1]!.attrs.text).toBe('An endnote.');
  });

  it('exposes notes in the read view for MCP tools', () => {
    const v = readView(scene(m));
    expect(v.text).toContain('plain[^1][^e1]');
    expect(v.text).toContain('[image: A lighthouse]');
    expect(v.footnotes).toEqual([
      { id: '1', kind: 'footnote', text: 'First italic\nSecond paragraph.' },
      { id: '1', kind: 'endnote', text: 'An endnote.' },
    ]);
  });

  it('replaces images with placeholders, flattens tables, lists headers/footers', () => {
    expect(inlines(m)).toContainEqual({ type: 'image', attrs: { alt: 'A lighthouse' } });
    expect(readView(scene(m)).text).toContain('cell one\ncell two');
    const warn = (code: string) =>
      m.report.items.filter((i) => i.code === code && i.level === 'warning');
    expect(warn('image')).toHaveLength(1);
    expect(warn('table')).toHaveLength(1);
    expect(warn('header_footer').flatMap((i) => i.samples)).toEqual([
      'header1.xml',
      'header2.xml',
      'footer1.xml',
    ]);
    expect(warn('single_blank_line')).toHaveLength(1);
  });

  it('keeps overlapping comments and nested insertions through Yjs', () => {
    const both = inlines(m).find((n) => n.type === 'text' && n.text === 'both')!;
    expect(both.type === 'text' && both.marks?.map((x) => x.type)).toEqual([
      'comment_anchor',
      'comment_anchor',
    ]);
    const added = inlines(m).find((n) => n.type === 'text' && n.text === ' added')!;
    expect(added.type === 'text' && added.marks?.length).toBe(2);
    expect(yDocToDoc(docToYDoc(scene(m)))).toEqual(scene(m));
  });

  it('round-trips everything through export', () => {
    const b = importDocx(exportDocx(m), { manuscriptId: 'm1' });
    expect(b.sections.map((s) => s.content)).toEqual(m.sections.map((s) => s.content));
    expect(b.comments).toEqual(m.comments);
  });

  it('declares the new nodes and marks in @coauthor/schema', () => {
    expect(MARK_TYPES).toEqual(expect.arrayContaining(['underline', 'strike', 'smallcaps']));
    expect(INLINE_NODE_TYPES).toEqual(expect.arrayContaining(['hard_break', 'footnote', 'image']));
  });
});

/** Zip with document.xml whose declared uncompressed size (local + central header) is forged. */
function forgeDeclaredSize(zip: Uint8Array, size: number): Uint8Array {
  const out = zip.slice();
  const dv = new DataView(out.buffer);
  for (let i = 0; i + 4 <= out.length; i++) {
    const sig = dv.getUint32(i, true);
    if (sig === 0x04034b50) dv.setUint32(i + 22, size, true);
    if (sig === 0x02014b50) dv.setUint32(i + 24, size, true);
  }
  return out;
}

describe('hostile input', () => {
  const big = () => {
    const para = `<w:p><w:r><w:t>${'Synthetic filler text for size. '.repeat(40)}</w:t></w:r></w:p>`;
    const xml = `<w:document ${NS}><w:body>${p(r('Chapter 1'), '<w:pStyle w:val="Heading1"/>')}${para.repeat(5200)}${p(r('THE END MARKER'))}</w:body></w:document>`;
    return zipSync({ 'word/document.xml': strToU8(xml) });
  };

  it("fails loudly when a part's declared size is forged (6.8 MB declared as 100 B)", () => {
    const zip = big();
    const honest = importDocx(zip);
    expect(JSON.stringify(honest.sections)).toContain('THE END MARKER');
    expect(() => importDocx(forgeDeclaredSize(zip, 100))).toThrow(/size mismatch/);
  });

  it('fails on a CRC mismatch', () => {
    const zip = zipSync({
      'word/document.xml': strToU8(`<w:document ${NS}><w:body/></w:document>`),
    });
    const dv = new DataView(zip.buffer);
    for (let i = 0; i + 4 <= zip.length; i++)
      if (dv.getUint32(i, true) === 0x02014b50) dv.setUint32(i + 16, 0xdeadbeef, true);
    expect(() => importDocx(zip)).toThrow(/checksum mismatch/);
  });

  it('counts real inflated bytes against the cap even when the declared size is tiny', () => {
    const saved = { ...DOCX_LIMITS };
    try {
      DOCX_LIMITS.maxPartBytes = 1024 * 1024;
      expect(() => importDocx(forgeDeclaredSize(big(), 100))).toThrow(/too large/);
    } finally {
      Object.assign(DOCX_LIMITS, saved);
    }
  });

  it('rejects DOCTYPE/ENTITY declarations', () => {
    const docx = zipSync({
      'word/document.xml': strToU8(
        `<?xml version="1.0"?><!DOCTYPE d [<!ENTITY a "aaaa">]><w:document ${NS}><w:body/></w:document>`,
      ),
    });
    expect(() => importDocx(docx)).toThrow(/DOCTYPE/);
  });

  it('refuses parts that inflate past the limit and skips unneeded parts', () => {
    const saved = { ...DOCX_LIMITS };
    try {
      DOCX_LIMITS.maxPartBytes = 4096;
      const bomb = zipSync({ 'word/document.xml': new Uint8Array(1_000_000) });
      expect(() => importDocx(bomb)).toThrow(/too large/);
      // A large media part is never inflated.
      expect(() => importDocx(sample())).not.toThrow();
      DOCX_LIMITS.maxInputBytes = 100;
      expect(() => importDocx(sample())).toThrow(/too large/);
    } finally {
      Object.assign(DOCX_LIMITS, saved);
    }
  });
});
