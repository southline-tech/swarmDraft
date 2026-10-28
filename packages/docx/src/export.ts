/** Structured manuscript -> .docx (RAD-218 round trip). */
import { strToU8, zipSync } from 'fflate';
import { escapeXml } from './xml';
import type { BlockNode, FootnoteNode, InlineNode, Mark, ParagraphStyle } from './model';
import type { ImportedManuscript, ImportedSection } from './import';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const STYLE_IDS: Record<ParagraphStyle, string> = {
  body: 'Normal',
  first: 'FirstParagraph',
  block_quote: 'Quote',
  epigraph: 'Epigraph',
  verse: 'Verse',
  centered: 'Centered',
};

const STYLES = `${HEAD}<w:styles xmlns:w="${W}">
<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:ind w:firstLine="360"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="FirstParagraph"><w:name w:val="First Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:firstLine="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Centered"><w:name w:val="Centered"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720" w:right="720" w:firstLine="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Epigraph"><w:name w:val="Epigraph"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Verse"><w:name w:val="Verse"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720" w:firstLine="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="SceneBreak"><w:name w:val="Scene Break"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="PartTitle"><w:name w:val="Part Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="BackMatterTitle"><w:name w:val="Back Matter Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
${[1, 2, 3, 4, 5, 6]
  .map(
    (n) =>
      `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${36 - n * 2}"/></w:rPr></w:style>`,
  )
  .join('\n')}
<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="ImagePlaceholder"><w:name w:val="Image Placeholder"/><w:rPr><w:color w:val="808080"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="EndnoteReference"><w:name w:val="endnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="EndnoteText"><w:name w:val="endnote text"/><w:pPr><w:ind w:firstLine="0"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:pPr><w:ind w:firstLine="0"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr></w:style>
</w:styles>`;

interface Out {
  footnotes: FootnoteNode['attrs'][];
  open: Set<string>;
}

function runProps(marks: Mark[]): string {
  let p = '';
  if (marks.some((m) => m.type === 'bold')) p += '<w:b/>';
  if (marks.some((m) => m.type === 'italic')) p += '<w:i/>';
  if (marks.some((m) => m.type === 'smallcaps')) p += '<w:smallCaps/>';
  if (marks.some((m) => m.type === 'strike')) p += '<w:strike/>';
  if (marks.some((m) => m.type === 'underline')) p += '<w:u w:val="single"/>';
  return p ? `<w:rPr>${p}</w:rPr>` : '';
}

function textRuns(text: string, marks: Mark[], deleted: boolean): string {
  const rPr = runProps(marks);
  const tag = deleted ? 'w:delText' : 'w:t';
  return text
    .split('\t')
    .map((part, i) => {
      const tab = i > 0 ? '<w:tab/>' : '';
      const t = part ? `<${tag} xml:space="preserve">${escapeXml(part)}</${tag}>` : '';
      return tab || t ? `<w:r>${rPr}${tab}${t}</w:r>` : '';
    })
    .join('');
}

function inline(nodes: InlineNode[] | undefined, out: Out): string {
  let xml = '';
  const all = nodes ?? [];
  all.forEach((n, idx) => {
    const marks = n.type === 'text' ? (n.marks ?? []) : [];
    const ids = new Set(marks.flatMap((m) => (m.type === 'comment_anchor' ? [m.attrs.id] : [])));
    for (const id of ids)
      if (!out.open.has(id)) {
        out.open.add(id);
        xml += `<w:commentRangeStart w:id="${escapeXml(id)}"/>`;
      }
    let run = '';
    if (n.type === 'text') {
      const ins = marks.filter((m) => m.type === 'suggestion_insert');
      const del = marks.filter((m) => m.type === 'suggestion_delete');
      run = textRuns(n.text, marks, del.length > 0);
      // Innermost first; nested/overlapping changes each get their own wrapper.
      for (const s of [...del, ...ins].reverse()) {
        if (!('attrs' in s)) continue;
        const a = s.attrs as { id: string; author: string; ts: string };
        const tag = s.type === 'suggestion_insert' ? 'w:ins' : 'w:del';
        const id = a.id.replace(/^docx-/, '');
        const date = a.ts ? ` w:date="${escapeXml(a.ts)}"` : '';
        run = `<${tag} w:id="${escapeXml(id)}" w:author="${escapeXml(a.author)}"${date}>${run}</${tag}>`;
      }
    } else if (n.type === 'hard_break') run = '<w:r><w:br/></w:r>';
    else if (n.type === 'image')
      run = `<w:r><w:rPr><w:rStyle w:val="ImagePlaceholder"/></w:rPr><w:t xml:space="preserve">[image: ${escapeXml(n.attrs.alt)}]</w:t></w:r>`;
    else {
      out.footnotes.push(n.attrs);
      const k = n.attrs.kind === 'endnote' ? 'endnote' : 'footnote';
      const style = k === 'endnote' ? 'EndnoteReference' : 'FootnoteReference';
      run = `<w:r><w:rPr><w:rStyle w:val="${style}"/></w:rPr><w:${k}Reference w:id="${escapeXml(n.attrs.id)}"/></w:r>`;
    }
    xml += run;
    // Close comments not continued by the next node.
    const next = all[idx + 1];
    const nextIds = new Set(
      next && next.type === 'text'
        ? (next.marks ?? []).flatMap((m) => (m.type === 'comment_anchor' ? [m.attrs.id] : []))
        : [],
    );
    for (const id of [...out.open])
      if (!nextIds.has(id)) {
        out.open.delete(id);
        xml += `<w:commentRangeEnd w:id="${escapeXml(id)}"/><w:r><w:commentReference w:id="${escapeXml(id)}"/></w:r>`;
      }
  });
  return xml;
}

const para = (style: string, body: string) =>
  `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${body}</w:p>`;
const PAGE_BREAK = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

function block(b: BlockNode, section: ImportedSection, out: Out): string {
  switch (b.type) {
    case 'paragraph':
      return para(STYLE_IDS[b.attrs.style] ?? 'Normal', inline(b.content, out));
    case 'heading': {
      const style =
        b.attrs.level === 1 && section.kind === 'part'
          ? 'PartTitle'
          : b.attrs.level === 1 && section.kind === 'back_matter'
            ? 'BackMatterTitle'
            : `Heading${Math.min(Math.max(b.attrs.level, 1), 6)}`;
      return para(style, inline(b.content, out));
    }
    case 'scene_break':
      return para(
        'SceneBreak',
        b.attrs.marker
          ? `<w:r><w:t xml:space="preserve">${escapeXml(b.attrs.marker)}</w:t></w:r>`
          : '',
      );
    case 'page_break':
      return PAGE_BREAK;
  }
}

export function exportDocx(m: ImportedManuscript): Uint8Array {
  const out: Out = { footnotes: [], open: new Set() };
  const parts: string[] = [];
  m.sections.forEach((s, i) => {
    const prev = m.sections[i - 1];
    if (
      i > 0 &&
      !(
        s.kind === 'chapter' &&
        prev?.kind === 'part' &&
        prev.id === s.parentId &&
        prev.content.content.length <= 1
      )
    )
      parts.push(PAGE_BREAK);
    for (const b of s.content.content) parts.push(block(b, s, out));
  });
  const document = `${HEAD}<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${parts.join('')}<w:sectPr><w:pgSz w:w="8640" w:h="12960"/><w:pgMar w:top="1080" w:right="900" w:bottom="1080" w:left="900" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const notesXml = (k: 'footnote' | 'endnote') => {
    const style = k === 'endnote' ? 'Endnote' : 'Footnote';
    const body = out.footnotes
      .filter((f) => (f.kind === 'endnote' ? 'endnote' : 'footnote') === k)
      .map((f) => {
        const paras: InlineNode[][] = f.content?.length
          ? f.content.map((p) => p.content ?? [])
          : [[{ type: 'text', text: f.text }]];
        const noteOut: Out = { footnotes: [], open: new Set() };
        const ps = paras
          .map(
            (inl, i) =>
              `<w:p><w:pPr><w:pStyle w:val="${style}Text"/></w:pPr>${i === 0 ? `<w:r><w:rPr><w:rStyle w:val="${style}Reference"/></w:rPr><w:${k}Ref/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r>` : ''}${inline(inl, noteOut)}</w:p>`,
          )
          .join('');
        return `<w:${k} w:id="${escapeXml(f.id)}">${ps}</w:${k}>`;
      })
      .join('');
    return `${HEAD}<w:${k}s xmlns:w="${W}"><w:${k} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:${k}><w:${k} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:${k}>${body}</w:${k}s>`;
  };
  const footnotes = notesXml('footnote');
  const endnotes = notesXml('endnote');
  const comments = `${HEAD}<w:comments xmlns:w="${W}">${m.comments
    .map(
      (c) =>
        `<w:comment w:id="${escapeXml(c.id)}" w:author="${escapeXml(c.author)}"${c.date ? ` w:date="${escapeXml(c.date)}"` : ''}>${c.body
          .split('\n')
          .map((l) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(l)}</w:t></w:r></w:p>`)
          .join('')}</w:comment>`,
    )
    .join('')}</w:comments>`;
  const ct = 'application/vnd.openxmlformats-officedocument.wordprocessingml';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${ct}.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="${ct}.styles+xml"/><Override PartName="/word/footnotes.xml" ContentType="${ct}.footnotes+xml"/><Override PartName="/word/endnotes.xml" ContentType="${ct}.endnotes+xml"/><Override PartName="/word/comments.xml" ContentType="${ct}.comments+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    ),
    '_rels/.rels': strToU8(
      `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    ),
    'docProps/core.xml': strToU8(
      `${HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escapeXml(m.title)}</dc:title>${m.author ? `<dc:creator>${escapeXml(m.author)}</dc:creator>` : ''}</cp:coreProperties>`,
    ),
    'word/_rels/document.xml.rels': strToU8(
      `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${rel}/footnotes" Target="footnotes.xml"/><Relationship Id="rId3" Type="${rel}/comments" Target="comments.xml"/><Relationship Id="rId4" Type="${rel}/endnotes" Target="endnotes.xml"/></Relationships>`,
    ),
    'word/document.xml': strToU8(document),
    'word/styles.xml': strToU8(STYLES),
    'word/footnotes.xml': strToU8(footnotes),
    'word/endnotes.xml': strToU8(endnotes),
    'word/comments.xml': strToU8(comments),
  };
  return zipSync(files, { level: 6 });
}
