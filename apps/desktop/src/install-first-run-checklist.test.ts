/** Every Batch B row in docs/qa/install-first-run-checklist.md names real coverage. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CHECKLIST = resolve(__dirname, '../../../docs/qa/install-first-run-checklist.md');
const COVERAGE_PAIR = /`([^`]+)`\s*—\s*`([^`]+)`/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveSourceFile(basename: string): string {
  if (basename.includes('/')) {
    return resolve(__dirname, basename);
  }
  if (basename.endsWith('.json')) {
    return resolve(__dirname, '../src-tauri', basename);
  }
  if (basename.endsWith('.nsi')) {
    return resolve(__dirname, '../src-tauri/windows', basename);
  }
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

describe('docs/qa/install-first-run-checklist.md (#34 Batch B)', () => {
  it('links every table row to Covered by or manual-only', () => {
    const md = readFileSync(CHECKLIST, 'utf8');
    const rows = md
      .split('\n')
      .filter((line) => /^\|\s*\d+\s*\|/.test(line))
      .map((line) => line.trim());
    expect(rows.length).toBe(7);
    for (const row of rows) {
      const lastCell = row.split('|').at(-2)?.trim() ?? '';
      expect(/Covered by:|manual-only/i.test(lastCell), `row missing coverage: ${row}`).toBe(true);
    }
  });

  it('names existing automated tests for non-manual rows', () => {
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
        const basename = match[1];
        const testName = match[2];
        if (basename === undefined || testName === undefined) continue;
        if (basename === 'tauri.conf.json' || basename === 'installer.nsi') continue;
        if (basename === 'pr-evidence/34/README.md') continue;
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

  it('per-user installer config matches Batch B (no admin, currentUser)', () => {
    const conf = readFileSync(resolve(__dirname, '../src-tauri/tauri.conf.json'), 'utf8');
    expect(conf).toContain('"installMode": "currentUser"');
    const nsi = readFileSync(resolve(__dirname, '../src-tauri/windows/installer.nsi'), 'utf8');
    expect(nsi).toMatch(/INSTALLMODE.*currentUser[\s\S]*RequestExecutionLevel user/);
    expect(nsi).toContain('CreateOrUpdateDesktopShortcut');
    expect(nsi).toContain('ObWelcomeCreate');
    expect(nsi).toContain('ObFinishCreate');
    expect(nsi).toContain('Install swarmDraft');
    expect(nsi).toContain('${NSD_Check} $ObRunCheckbox');
  });

  it('toolbar has no writer Save control (autosave only)', () => {
    const toolbar = readFileSync(resolve(__dirname, 'toolbar/EditorToolbar.vue'), 'utf8');
    expect(toolbar).not.toMatch(/data-test="[^"]*save[^"]*"/i);
    expect(toolbar).not.toMatch(/>Save</);
  });
});
