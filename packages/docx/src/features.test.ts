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

const chapterBody = (m: ImportedManuscript) =>
  m.sections.find((s) => s.kind === 'chapter')!.content;
const inlines = (m: ImportedManuscript) =>
  chapterBody(m).content.flatMap((b) => ('content' in b ? (b.content ?? []) : [])) as InlineNode[];

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
    const v = readView(chapterBody(m));
    expect(v.text).toContain('plain[^1][^e1]');
    expect(v.text).toContain('[image: A lighthouse]');
    expect(v.footnotes).toEqual([
      { id: '1', kind: 'footnote', text: 'First italic\nSecond paragraph.' },
      { id: '1', kind: 'endnote', text: 'An endnote.' },
    ]);
  });

  it('replaces images with placeholders, flattens tables, lists headers/footers', () => {
    expect(inlines(m)).toContainEqual({ type: 'image', attrs: { alt: 'A lighthouse' } });
    expect(readView(chapterBody(m)).text).toContain('cell one\ncell two');
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
    expect(yDocToDoc(docToYDoc(chapterBody(m)))).toEqual(chapterBody(m));
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

describe('id collisions and zip integrity', () => {
  const docx = (body: string, comments: string) =>
    zipSync({
      'word/document.xml': strToU8(`<w:document ${NS}><w:body>${body}</w:body></w:document>`),
      'word/comments.xml': strToU8(`<w:comments ${NS}>${comments}</w:comments>`),
    });
  const patchCentral = (zip: Uint8Array, fn: (dv: DataView, at: number) => void) => {
    const dv = new DataView(zip.buffer);
    for (let i = 0; i + 4 <= zip.length; i++) if (dv.getUint32(i, true) === 0x02014b50) fn(dv, i);
    return zip;
  };

  it('gives duplicate/missing comment and revision ids fresh ids and keeps every comment', () => {
    const body = p(
      '<w:commentRangeStart w:id="5"/>' +
        r('first') +
        '<w:commentRangeEnd w:id="5"/>' +
        '<w:commentRangeStart w:id="5"/>' +
        r(' second') +
        '<w:commentRangeEnd w:id="5"/>' +
        '<w:commentRangeStart/>' +
        r(' third') +
        '<w:commentRangeEnd/>' +
        '<w:ins w:id="9" w:author="Ann">' +
        '<w:ins w:id="9" w:author="Bo">' +
        r(' nested') +
        '</w:ins></w:ins>' +
        '<w:del w:author="Cy">' +
        `<w:r><w:delText> gone</w:delText></w:r></w:del>`,
    );
    const comments =
      `<w:comment w:id="5" w:author="Ann">${p(r('one'))}</w:comment>` +
      `<w:comment w:id="5" w:author="Bo">${p(r('two'))}</w:comment>` +
      `<w:comment w:author="Cy">${p(r('three'))}</w:comment>`;
    const m = importDocx(docx(body, comments));
    expect(m.comments.map((c) => c.body)).toEqual(['one', 'two', 'three']);
    expect(new Set(m.comments.map((c) => c.id)).size).toBe(3);
    const all = m.sections.flatMap((s) => s.content.content);
    const text = all.flatMap((b) => ('content' in b ? (b.content ?? []) : [])) as InlineNode[];
    const ids = (t: string, type: string) => {
      const n = text.find((x) => x.type === 'text' && x.text === t)!;
      return n.type === 'text'
        ? (n.marks ?? [])
            .filter((k) => k.type === type)
            .map((k) => (k as { attrs: { id: string } }).attrs.id)
        : [];
    };
    const [c1] = ids('first', 'comment_anchor');
    const [c2] = ids(' second', 'comment_anchor');
    const [c3] = ids(' third', 'comment_anchor');
    expect(m.comments.map((c) => c.id)).toEqual([c1, c2, c3]);
    const ins = ids(' nested', 'suggestion_insert');
    expect(ins).toHaveLength(2);
    expect(new Set(ins).size).toBe(2);
    expect(ids(' gone', 'suggestion_delete')[0]).toMatch(/^docx-\d+$/);
    expect(m.report.items.filter((i) => i.code === 'duplicate_id').length).toBeGreaterThanOrEqual(
      4,
    );
    expect(m.report.items.map((i) => i.code)).not.toContain('orphan_comment');
    // Fresh ids survive a round trip.
    const b = importDocx(exportDocx(m));
    expect(b.comments.map((c) => c.body)).toEqual(['one', 'two', 'three']);
    expect(b.report.items.map((i) => i.code)).not.toContain('duplicate_id');
  });

  it('throws on duplicate zip entry names instead of letting the last one win', () => {
    const zip = zipSync({
      'word/document.xml': strToU8(
        `<w:document ${NS}><w:body>${p(r('real'))}</w:body></w:document>`,
      ),
      'word/documenX.xml': strToU8(
        `<w:document ${NS}><w:body>${p(r('shadow'))}</w:body></w:document>`,
      ),
    });
    // Rename every "documenX" to "document" (local + central headers).
    const name = strToU8('word/documenX.xml');
    for (let i = 0; i + name.length <= zip.length; i++)
      if (name.every((c, j) => zip[i + j] === c)) zip[i + name.length - 5] = 't'.charCodeAt(0);
    expect(() => importDocx(zip)).toThrow(/Duplicate zip entry "word\/document.xml"/);
  });

  it('rejects encrypted entries with a clear error', () => {
    const zip = zipSync({
      'word/document.xml': strToU8(`<w:document ${NS}><w:body/></w:document>`),
    });
    patchCentral(zip, (dv, at) => dv.setUint16(at + 8, dv.getUint16(at + 8, true) | 1, true));
    expect(() => importDocx(zip)).toThrow(/encrypted/);
  });
});

describe('comment ranges never lose a body or leak', () => {
  const build = (body: string, comments: string, footnotes = '') =>
    importDocx(
      zipSync({
        'word/document.xml': strToU8(`<w:document ${NS}><w:body>${body}</w:body></w:document>`),
        'word/comments.xml': strToU8(`<w:comments ${NS}>${comments}</w:comments>`),
        ...(footnotes
          ? { 'word/footnotes.xml': strToU8(`<w:footnotes ${NS}>${footnotes}</w:footnotes>`) }
          : {}),
      }),
    );
  const def = (id: string, body: string) =>
    `<w:comment w:id="${id}" w:author="Ann">${p(r(body))}</w:comment>`;
  const texts = (m: ImportedManuscript) =>
    m.sections
      .flatMap((s) => s.content.content)
      .flatMap((b) => ('content' in b ? (b.content ?? []) : [])) as InlineNode[];
  const anchorsOf = (m: ImportedManuscript, t: string) => {
    const n = texts(m).find((x) => x.type === 'text' && x.text === t);
    if (!n || n.type !== 'text') throw new Error(`no text ${t}`);
    return (n.marks ?? []).flatMap((k) =>
      k.type === 'comment_anchor' ? [(k as { attrs: { id: string } }).attrs.id] : [],
    );
  };
  const codes = (m: ImportedManuscript) => m.report.items.map((i) => i.code);

  it('anchors zero-width and reference-only comments and keeps extra definitions', () => {
    const m = build(
      p(
        r('lead') +
          '<w:commentRangeStart w:id="1"/><w:commentRangeEnd w:id="1"/>' +
          r(' point') +
          '<w:r><w:commentReference w:id="2"/></w:r>' +
          r(' ref'),
      ) + p(r('tail')),
      def('1', 'zero width') + def('2', 'reference only') + def('3', 'no range at all'),
    );
    expect(m.comments.map((c) => c.body)).toEqual([
      'zero width',
      'reference only',
      'no range at all',
    ]);
    expect(anchorsOf(m, ' point')).toEqual(['1']);
    expect(anchorsOf(m, ' ref')).toEqual(['2']);
    expect(anchorsOf(m, 'lead')).toContain('3');
    expect(codes(m)).toContain('orphan_comment');
    const back = importDocx(exportDocx(m));
    expect(back.comments.map((c) => c.body)).toEqual(m.comments.map((c) => c.body));
  });

  it('cuts end-before-start and unclosed ranges back to their paragraph, with warnings', () => {
    const m = build(
      p('<w:commentRangeEnd w:id="4"/>' + r('x') + '<w:commentRangeStart w:id="4"/>' + r('y')) +
        p(r('later')) +
        p('<w:commentRangeStart w:id="5"/>' + r('open')) +
        p(r('after open')),
      def('4', 'reversed') + def('5', 'unclosed'),
    );
    expect(anchorsOf(m, 'y')).toEqual(['4']);
    expect(anchorsOf(m, 'x')).toEqual([]);
    expect(anchorsOf(m, 'later')).toEqual([]);
    expect(anchorsOf(m, 'open')).toEqual(['5']);
    expect(anchorsOf(m, 'after open')).toEqual([]);
    expect(codes(m)).toEqual(expect.arrayContaining(['unmatched_comment_end', 'unclosed_comment']));
    expect(m.comments.map((c) => c.body)).toEqual(['reversed', 'unclosed']);
  });

  it('keeps open-range state separate per story (no leak from footnotes into the body)', () => {
    const m = build(
      p(
        r('body') +
          `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r>`,
      ) + p(r('more body')),
      def('6', 'in note'),
      `<w:footnote w:id="1">${p('<w:commentRangeStart w:id="6"/>' + r('note text'))}${p(r('note two'))}</w:footnote>`,
    );
    expect(anchorsOf(m, 'body')).toEqual([]);
    expect(anchorsOf(m, 'more body')).toEqual([]);
    const note = texts(m).find((n) => n.type === 'footnote') as FootnoteNode;
    const noteMarks = (i: number) =>
      (note.attrs.content[i]!.content ?? []).flatMap((n) =>
        n.type === 'text' ? (n.marks ?? []).map((k) => k.type) : [],
      );
    expect(noteMarks(0)).toContain('comment_anchor');
    expect(noteMarks(1)).not.toContain('comment_anchor');
    expect(m.comments.map((c) => c.body)).toEqual(['in note']);
    expect(codes(m)).toContain('unclosed_comment');
  });
  it('round-trips a comment spanning several paragraphs as one comment, same id', () => {
    const m = build(
      p(r('lead ') + '<w:commentRangeStart w:id="1"/>' + r('first')) +
        p(r('second')) +
        p(r('third') + '<w:commentRangeEnd w:id="1"/>' + r(' tail')),
      def('1', 'spans three'),
    );
    expect(anchorsOf(m, 'second')).toEqual(['1']);
    const back = importDocx(exportDocx(m));
    expect(back.comments.map((c) => [c.id, c.body])).toEqual([['1', 'spans three']]);
    for (const t of ['first', 'second', 'third']) expect(anchorsOf(back, t)).toEqual(['1']);
    expect(anchorsOf(back, ' tail')).toEqual([]);
    expect(codes(back)).not.toContain('duplicate_id');
    expect(codes(back)).not.toContain('orphan_comment');
    // And a second trip is stable.
    const again = importDocx(exportDocx(back));
    expect(again.comments.map((c) => [c.id, c.body])).toEqual([['1', 'spans three']]);
    expect(codes(again)).not.toContain('duplicate_id');
  });

  it('round-trips a comment range crossing a flattened table', () => {
    const m = build(
      p('<w:commentRangeStart w:id="7"/>' + r('before')) +
        `<w:tbl><w:tr><w:tc>${p(r('cell'))}</w:tc></w:tr></w:tbl>` +
        p(r('after') + '<w:commentRangeEnd w:id="7"/>'),
      def('7', 'across table'),
    );
    const back = importDocx(exportDocx(m));
    expect(back.comments.map((c) => [c.id, c.body])).toEqual([['7', 'across table']]);
    for (const t of ['before', 'cell', 'after']) expect(anchorsOf(back, t)).toEqual(['7']);
    expect(codes(back)).not.toContain('duplicate_id');
  });

  it('puts the comment id and a snippet in warning details', () => {
    const m = build(
      p('<w:commentRangeEnd w:id="9"/>' + r('x')) +
        p('<w:commentRangeStart w:id="5"/>' + r('open')),
      def('5', 'unclosed body here') + def('9', 'end only') + def('9', 'dup def'),
    );
    const samples = (code: string) => m.report.items.find((i) => i.code === code)?.samples ?? [];
    expect(samples('unclosed_comment')).toEqual(['5: unclosed body here']);
    expect(samples('unmatched_comment_end')[0]).toMatch(/^9: /);
    expect(samples('duplicate_id')).toEqual(['9: dup def']);
    const orphan = m.report.items.find((i) => i.code === 'orphan_comment');
    expect(orphan?.message).toMatch(/section "/);
  });

  it('carries the comment body in the warning when the document has no text', () => {
    const m = build('', def('3', 'lonely note'));
    const item = m.report.items.find((i) => i.code === 'orphan_comment');
    expect(item?.samples).toEqual(['3: lonely note']);
  });
});

describe('orphan comment anchors', () => {
  it('drops an anchor whose id has no comments.xml entry and reports orphan_anchor', () => {
    const body = p(
      r('Before ') +
        '<w:commentRangeStart w:id="7"/>' +
        r('kept range') +
        '<w:commentRangeEnd w:id="7"/>' +
        '<w:commentRangeStart w:id="42"/>' +
        r(' stray words') +
        '<w:commentRangeEnd w:id="42"/>',
    );
    const zip = zipSync({
      'word/document.xml': strToU8(`<w:document ${NS}><w:body>${body}</w:body></w:document>`),
      'word/comments.xml': strToU8(
        `<w:comments ${NS}><w:comment w:id="7" w:author="Ann">${p(r('real'))}</w:comment></w:comments>`,
      ),
    });
    const manuscript = importDocx(zip, { manuscriptId: 'm1' });
    const report = manuscript.report;
    const json = JSON.stringify(manuscript.sections);
    expect(json).toContain('"comment_anchor","attrs":{"id":"7"}');
    expect(json).not.toContain('"id":"42"');
    expect(manuscript.comments.map((c) => c.id)).toEqual(['7']);
    const item = report.items.find((i) => i.code === 'orphan_anchor');
    expect(item?.level).toBe('warning');
    expect(item?.samples).toEqual(['42: stray words']);
    expect(json).toContain('stray words');
  });

  it('reports a point (zero-width) orphan anchor without text', () => {
    const body = p('<w:commentRangeStart w:id="9"/><w:commentRangeEnd w:id="9"/>' + r('after'));
    const zip = zipSync({
      'word/document.xml': strToU8(`<w:document ${NS}><w:body>${body}</w:body></w:document>`),
    });
    const manuscript = importDocx(zip, { manuscriptId: 'm1' });
    const report = manuscript.report;
    expect(JSON.stringify(manuscript.sections)).not.toContain('comment_anchor');
    expect(report.items.find((i) => i.code === 'orphan_anchor')?.samples).toEqual(['9: (no text)']);
    expect(JSON.stringify(manuscript.sections)).toContain('after');
  });

  it('reports a point orphan in the middle of a word without the next text', () => {
    const body = p(
      r('a') + '<w:commentRangeStart w:id="88"/><w:commentRangeEnd w:id="88"/>' + r('b'),
    );
    const zip = zipSync({
      'word/document.xml': strToU8(`<w:document ${NS}><w:body>${body}</w:body></w:document>`),
    });
    const samples =
      importDocx(zip, { manuscriptId: 'm1' }).report.items.find((i) => i.code === 'orphan_anchor')
        ?.samples ?? [];
    expect(samples).toEqual(['88: (no text)']);
  });

  it('drops orphan anchors inside footnotes and endnotes too', () => {
    const ref = (kind: string) => `<w:r><w:${kind}Reference w:id="1"/></w:r>`;
    const note = (kind: string, id: string, text: string) =>
      `<w:${kind}s ${NS}><w:${kind} w:id="1">${p(
        `<w:commentRangeStart w:id="${id}"/>${r(text)}<w:commentRangeEnd w:id="${id}"/>`,
      )}</w:${kind}></w:${kind}s>`;
    const zip = zipSync({
      'word/document.xml': strToU8(
        `<w:document ${NS}><w:body>${p(r('Body') + ref('footnote') + ref('endnote'))}</w:body></w:document>`,
      ),
      'word/footnotes.xml': strToU8(note('footnote', '51', 'foot words')),
      'word/endnotes.xml': strToU8(note('endnote', '52', 'end words')),
    });
    const manuscript = importDocx(zip, { manuscriptId: 'm1' });
    const json = JSON.stringify(manuscript.sections);
    expect(json).toContain('foot words');
    expect(json).toContain('end words');
    expect(json).not.toContain('comment_anchor');
    const item = manuscript.report.items.find((i) => i.code === 'orphan_anchor');
    expect(item?.samples).toEqual(expect.arrayContaining(['51: foot words', '52: end words']));
  });

  it('reports the original docx id, not a reassigned one', () => {
    // Overlapping ranges reuse id 5 with no comments.xml: the inner one gets a fresh id.
    const body = p(
      '<w:commentRangeStart w:id="5"/>' +
        r('one') +
        '<w:commentRangeStart w:id="5"/>' +
        r('two') +
        '<w:commentRangeEnd w:id="5"/><w:commentRangeEnd w:id="5"/>',
    );
    const zip = zipSync({
      'word/document.xml': strToU8(`<w:document ${NS}><w:body>${body}</w:body></w:document>`),
    });
    const manuscript = importDocx(zip, { manuscriptId: 'm1' });
    const samples = manuscript.report.items.find((i) => i.code === 'orphan_anchor')?.samples ?? [];
    expect(samples.length).toBeGreaterThan(0);
    for (const s of samples) expect(s).toMatch(/^5: /);
    expect(samples.join()).not.toMatch(/100000\d/);
  });
});
