import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { importDocx, type ImportedManuscript } from './import';
import {
  buildSyntheticLargeDocx,
  buildSyntheticNoChapterHeadingsDocx,
} from './synthetic-large-docx';

const fixtureDir = fileURLToPath(
  new URL('../../../fixtures/manuscripts/docx-import/', import.meta.url),
);

const FIXTURE_FILES = [
  'mock-manuscript.docx',
  'edge-false-positives.docx',
  'edge-no-headings.docx',
  'edge-soft-breaks-only.docx',
] as const;

/** Stable digest of import output (regression guard for perf refactors). */
function importDigest(bytes: Uint8Array): string {
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
    report: m.report,
  });
  const m = importDocx(bytes, { manuscriptId: 'm1' });
  return createHash('sha256')
    .update(JSON.stringify(strip(m)))
    .digest('hex');
}

const FIXTURE_DIGESTS: Record<(typeof FIXTURE_FILES)[number], string> = {
  'mock-manuscript.docx': 'a0b6655d6721b29bcafec2fb075d9975ad1554a806bd94131c2923d1926c4f7a',
  'edge-false-positives.docx': 'b72082bce075450b69941dd6140c76cf17a1a04f0c1c574ddf44902361e6695d',
  'edge-no-headings.docx': '63b03e7207ec600ae4c50e529dcfcefe8ea3484f6aa3f04a3b672b5dc46bd6fd',
  'edge-soft-breaks-only.docx': '85a12d1ffc720e3b47e2ff3776ad65955ec3c2e142af5ebff6932f23239a731f',
};

describe('import perf (#300)', () => {
  it('fixture import output unchanged (SHA-256 of stripped manuscript)', () => {
    for (const name of FIXTURE_FILES) {
      const bytes = readFileSync(fixtureDir + name);
      expect(importDigest(bytes)).toBe(FIXTURE_DIGESTS[name]);
    }
  });

  const SYNTHETIC_LARGE_DIGEST = '9cf20bedfe4967460cef357e15f19dfae42fffce53ff58207ce5de7743aea760';

  it('imports ~350-page synthetic doc within budget', () => {
    const docx = buildSyntheticLargeDocx();
    expect(importDigest(docx)).toBe(SYNTHETIC_LARGE_DIGEST);
    const t0 = performance.now();
    const m = importDocx(docx, { manuscriptId: 'perf' });
    const ms = performance.now() - t0;
    expect(m.report.summary.chapters).toBeGreaterThanOrEqual(30);
    expect(m.report.summary.paragraphs).toBeGreaterThan(3000);
    expect(ms).toBeLessThan(15_000);
    if (!process.env.CI) expect(ms).toBeLessThan(2000);
  });

  it('no-chapter-heading path stays fast on large body (title-page skip)', () => {
    const docx = buildSyntheticNoChapterHeadingsDocx({ pages: 350, runsPerParagraph: 8 });
    const t0 = performance.now();
    const m = importDocx(docx, { manuscriptId: 'perf' });
    const ms = performance.now() - t0;
    expect(m.report.items.map((i) => i.code)).toContain('no_chapters');
    expect(ms).toBeLessThan(15_000);
  });
});

describe('plain CHAPTER lines (#303)', () => {
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const styles = strToU8(
    `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`,
  );
  const mini = (body: string) =>
    importDocx(
      zipSync({
        'word/document.xml': strToU8(
          `<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`,
        ),
        'word/styles.xml': styles,
      }),
      { manuscriptId: 'm1' },
    );
  const blocks = (m: ImportedManuscript, kind: string) => m.sections.filter((s) => s.kind === kind);

  it('splits on two plain CHAPTER lines and flags ambiguous_chapter', () => {
    const m = mini(
      `<w:p><w:r><w:t>CHAPTER ONE</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>First scene.</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>CHAPTER TWO</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>Second scene.</w:t></w:r></w:p>`,
    );
    expect(blocks(m, 'chapter').map((s) => s.title)).toEqual(['CHAPTER ONE', 'CHAPTER TWO']);
    const ambiguous = m.report.items.find((i) => i.code === 'ambiguous_chapter');
    expect(ambiguous?.count).toBe(2);
  });

  it('does not split on a single plain CHAPTER line or chapter phrase in prose', () => {
    const m = mini(
      `<w:p><w:r><w:t>CHAPTER ONE</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>Chapter two was hard.</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>Only chapter body.</w:t></w:r></w:p>`,
    );
    expect(blocks(m, 'chapter')).toHaveLength(1);
    expect(blocks(m, 'chapter')[0]!.title).toBe('Untitled');
    expect(m.report.items.map((i) => i.code)).toContain('no_chapters');
    expect(m.report.items.some((i) => i.code === 'ambiguous_chapter')).toBe(false);
    const body = blocks(m, 'chapter')[0]!
      .content.content.map((b) =>
        'content' in b
          ? (b.content ?? []).map((n) => (n.type === 'text' ? n.text : '')).join('')
          : '',
      )
      .join('\n');
    expect(body).toContain('CHAPTER ONE');
    expect(body).toContain('Chapter two was hard.');
  });
});

describe('title page opening scan (#309)', () => {
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const styles = strToU8(
    `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`,
  );
  const para = (inner: string) => `<w:p>${inner}</w:p>`;
  const text = (t: string) => para(`<w:r><w:t>${t}</w:t></w:r>`);
  const centered = (t: string) =>
    para(`<w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>${t}</w:t></w:r>`);

  it('no-chapter book: keeps deep dedication and title-like lines; drops opening title page only', () => {
    const opening = 'Opening line of the novel with enough words to read as body text here.';
    const parts: string[] = [centered('THE LONG ROAD'), text('by Pat Example'), text(opening)];
    for (let i = 0; i < 120; i++) parts.push(text(`Middle body paragraph number ${i} for volume.`));
    parts.push(centered('For Alex, always.'));
    parts.push(centered('THE LONG ROAD'));
    parts.push(text('Final closing paragraph at the end of the book.'));

    const inputParaCount = parts.length;
    const m = importDocx(
      zipSync({
        'word/document.xml': strToU8(
          `<w:document xmlns:w="${W}"><w:body>${parts.join('')}</w:body></w:document>`,
        ),
        'word/styles.xml': styles,
      }),
      { manuscriptId: 'm1' },
    );
    expect(m.report.summary.chapters).toBe(0);
    expect(m.report.items.map((i) => i.code)).toContain('no_chapters');
    expect(m.report.summary.paragraphs).toBe(inputParaCount);

    const ch = m.sections.find((s) => s.kind === 'chapter')!;
    const bodyParas = ch.content.content.filter((b) => b.type === 'paragraph');
    const bodyText = bodyParas
      .map((b) =>
        'content' in b
          ? (b.content ?? []).map((n) => (n.type === 'text' ? n.text : '')).join('')
          : '',
      )
      .join('\n');

    expect(bodyText).toContain('Middle body paragraph number 119');
    expect(bodyText).toContain('For Alex, always.');
    expect(bodyText).toContain('Final closing paragraph');
    expect(bodyText).not.toContain('by Pat Example');
    expect(bodyText.startsWith('Opening line')).toBe(true);
    expect(bodyText).toContain('For Alex, always.');
    expect(bodyText).toContain('THE LONG ROAD');
    expect(bodyText.trimEnd().endsWith('Final closing paragraph at the end of the book.')).toBe(
      true,
    );

    const skipped = inputParaCount - bodyParas.length;
    expect(skipped).toBeGreaterThan(0);
    expect(skipped).toBeLessThan(6);
  });
});
