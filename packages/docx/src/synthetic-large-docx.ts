/** Generated in tests only — not committed as a .docx file (#300). */
import { strToU8, zipSync } from 'fflate';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

export interface SyntheticLargeDocxOptions {
  /** Approximate page count (paragraph groups). */
  pages?: number;
  /** Body paragraphs per page (excluding chapter heading). */
  paragraphsPerPage?: number;
  /** Word runs per body paragraph (simulates split runs in real exports). */
  runsPerParagraph?: number;
}

const defaultStyles = strToU8(
  `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`,
);

function bodyParagraph(page: number, para: number, runs: number): string {
  let runXml = '';
  for (let r = 0; r < runs; r++) {
    runXml += `<w:r><w:t>word${r} </w:t></w:r>`;
  }
  return `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr>${runXml}</w:p>`;
}

/** Zip bytes for a large novel-shaped document.xml (heading 1 chapters + dense body). */
export function buildSyntheticLargeDocx(options: SyntheticLargeDocxOptions = {}): Uint8Array {
  const pages = options.pages ?? 350;
  const paragraphsPerPage = options.paragraphsPerPage ?? 12;
  const runsPerParagraph = options.runsPerParagraph ?? 12;
  const parts: string[] = [];
  for (let page = 0; page < pages; page++) {
    if (page % 10 === 0) {
      const ch = page / 10 + 1;
      parts.push(
        `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Chapter ${ch}</w:t></w:r></w:p>`,
      );
    }
    for (let p = 0; p < paragraphsPerPage; p++) {
      parts.push(bodyParagraph(page, p, runsPerParagraph));
    }
  }
  const xml = `<w:document xmlns:w="${W}"><w:body>${parts.join('')}</w:body></w:document>`;
  return zipSync({
    'word/document.xml': strToU8(xml),
    'word/styles.xml': defaultStyles,
  });
}

/** Same scale as {@link buildSyntheticLargeDocx} but no heading styles (no-chapters path). */
export function buildSyntheticNoChapterHeadingsDocx(
  options: SyntheticLargeDocxOptions = {},
): Uint8Array {
  const pages = options.pages ?? 350;
  const paragraphsPerPage = options.paragraphsPerPage ?? 12;
  const runsPerParagraph = options.runsPerParagraph ?? 12;
  const parts: string[] = [];
  for (let page = 0; page < pages; page++) {
    for (let p = 0; p < paragraphsPerPage; p++) {
      parts.push(bodyParagraph(page, p, runsPerParagraph));
    }
  }
  const xml = `<w:document xmlns:w="${W}"><w:body>${parts.join('')}</w:body></w:document>`;
  return zipSync({
    'word/document.xml': strToU8(xml),
    'word/styles.xml': defaultStyles,
  });
}
