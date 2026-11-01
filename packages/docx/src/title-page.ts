/**
 * Manuscript title-page heuristics (#235): contact block, centered title, byline.
 */
export interface TitlePagePara {
  text: string;
  centered: boolean;
  maxSize: number;
  allBold: boolean;
  indLeft: number;
}

export interface TitlePageMeta {
  title?: string;
  author?: string;
}

const EMAIL_RE = /@/;
const WORD_COUNT_RE = /\b[\d,]+\s*(words?|w\.?c\.?)\b/i;
const BYLINE_RE = /^by\s+/i;
const NOVEL_RE = /^a novel$/i;
const PHONE_RE = /^[\d\s().+-]{7,}$/;

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Title-case an all-caps line ("MEMORY WIPE" → "Memory Wipe"). */
export function displayTitleFromManuscriptLine(line: string): string {
  const t = norm(line);
  if (!t) return t;
  const letters = t.replace(/[^A-Za-zÀ-ÖØ-öø-ʸ]/g, '');
  if (letters.length >= 2 && letters === letters.toUpperCase() && t.split(/\s+/).length <= 4) {
    return t
      .toLowerCase()
      .replace(/\b[\p{L}\p{N}']+/gu, (w) => w.charAt(0).toUpperCase() + w.slice(1));
  }
  return t;
}

function isContactOrMeta(text: string, p: TitlePagePara): boolean {
  const t = norm(text);
  if (!t) return true;
  if (EMAIL_RE.test(t)) return true;
  if (WORD_COUNT_RE.test(t)) return true;
  if (PHONE_RE.test(t)) return true;
  if (p.indLeft >= 360 && !p.centered && t.length <= 80) return true;
  return false;
}

function isDisplayLine(p: TitlePagePara): boolean {
  const t = norm(p.text);
  if (!t || isContactOrMeta(t, p)) return false;
  if (NOVEL_RE.test(t)) return false;
  if (BYLINE_RE.test(t)) return false;
  return p.centered || p.maxSize >= 28 || (p.allBold && t.length <= 120);
}

/** Pick the book title from title-page paragraphs (not the contact block). */
export function parseTitlePageMeta(paras: TitlePagePara[]): TitlePageMeta {
  const lines = paras.map((p) => norm(p.text)).filter(Boolean);
  let title: string | undefined;
  let author: string | undefined;

  const display = paras.filter((p) => isDisplayLine(p));
  if (display.length) {
    title = display.reduce(
      (best, p) => {
        const t = norm(p.text);
        if (BYLINE_RE.test(t) || NOVEL_RE.test(t)) return best;
        const score =
          (p.centered ? 4 : 0) +
          (p.maxSize >= 28 ? 3 : 0) +
          (p.allBold ? 2 : 0) +
          Math.min(t.length, 80) / 40;
        if (!best || score > best.score) return { text: t, score };
        return best;
      },
      null as { text: string; score: number } | null,
    )?.text;
    if (title) title = displayTitleFromManuscriptLine(title);
  }

  for (const t of lines) {
    const by = BYLINE_RE.exec(t);
    if (by) {
      author = t.replace(BYLINE_RE, '').trim();
      break;
    }
  }
  if (!author) {
    const candidates = display
      .map((p) => norm(p.text))
      .filter((t) => t && t !== title && !NOVEL_RE.test(t) && !BYLINE_RE.test(t));
    if (candidates.length >= 2 && title) {
      const after = candidates.find((t) => t !== title);
      if (after && after.length <= 80 && !after.includes('@')) author = after;
    }
  }

  return { title, author };
}

/** Paragraph indices to drop from stored title-page / pre-chapter body (#235). */
export function titlePageSkipIndices(paras: TitlePagePara[]): Set<number> {
  const skip = new Set<number>();
  paras.forEach((p, i) => {
    const t = norm(p.text);
    if (!t) {
      skip.add(i);
      return;
    }
    if (isContactOrMeta(t, p)) skip.add(i);
    if (BYLINE_RE.test(t)) skip.add(i);
    if (NOVEL_RE.test(t)) skip.add(i);
    const meta = parseTitlePageMeta(paras);
    if (meta.title && norm(p.text) === meta.title) skip.add(i);
  });
  return skip;
}

export function headingsMatch(a: string, b: string): boolean {
  return norm(a).localeCompare(norm(b), undefined, { sensitivity: 'accent' }) === 0;
}
