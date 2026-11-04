/** #285: every QA row names automated coverage or manual-only. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CHECKLIST = resolve(__dirname, '../../../docs/qa/new-draft-checklist.md');

const COVERAGE_PAIR = /`([^`]+)`\s*—\s*`([^`]+)`/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveSourceFile(basename: string): string {
  if (basename.endsWith('.rs')) {
    return resolve(__dirname, '../src-tauri/src', basename);
  }
  return resolve(__dirname, basename);
}

function namesTest(source: string, testName: string, isRust: boolean): boolean {
  const name = escapeRegExp(testName);
  if (isRust) {
    return new RegExp(`\\bfn\\s+${name}\\s*\\(`).test(source);
  }
  return new RegExp(`\\bit\\(\\s*['\`]${name}['\`]`).test(source);
}

describe('docs/qa/new-draft-checklist.md (#285)', () => {
  it('links every table row to Covered by or manual-only', () => {
    const md = readFileSync(CHECKLIST, 'utf8');
    const rows = md
      .split('\n')
      .filter((line) => /^\|\s*\d+\s*\|/.test(line))
      .map((line) => line.trim());
    expect(rows.length).toBeGreaterThanOrEqual(11);
    for (const row of rows) {
      const lastCell = row.split('|').at(-2)?.trim() ?? '';
      expect(/Covered by:|manual-only/i.test(lastCell), `row missing coverage: ${row}`).toBe(true);
    }
  });

  it('names existing automated tests under desktop or src-tauri src', () => {
    const md = readFileSync(CHECKLIST, 'utf8');
    const rows = md
      .split('\n')
      .filter((line) => /^\|\s*\d+\s*\|/.test(line))
      .map((line) => line.trim());

    const sourceCache = new Map<string, string>();

    for (const row of rows) {
      const lastCell = row.split('|').at(-2)?.trim() ?? '';
      if (/manual-only/i.test(lastCell)) continue;

      COVERAGE_PAIR.lastIndex = 0;
      let match: RegExpExecArray | null;
      let foundPair = false;
      while ((match = COVERAGE_PAIR.exec(lastCell)) !== null) {
        foundPair = true;
        const [, basename, testName] = match;
        const path = resolveSourceFile(basename);
        let source = sourceCache.get(path);
        if (source === undefined) {
          source = readFileSync(path, 'utf8');
          sourceCache.set(path, source);
        }
        const isRust = basename.endsWith('.rs');
        expect(
          namesTest(source, testName, isRust),
          `missing ${isRust ? 'fn' : 'it'} ${testName} in ${basename}`,
        ).toBe(true);
      }
      expect(foundPair, `no \`file\` — \`test\` pairs in: ${lastCell}`).toBe(true);
    }
  });
});
