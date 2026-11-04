/** #285: every QA row names automated coverage or manual-only. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CHECKLIST = resolve(__dirname, '../../../docs/qa/new-draft-checklist.md');

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
});
