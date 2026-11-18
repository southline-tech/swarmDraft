/**
 * #352: the checked, non-update uninstall path in installer.nsi also removes the
 * pre-rename data folders. NSIS itself is not executed here; this locks the script
 * text that makensis compiles.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const NSI = readFileSync(resolve(__dirname, '../src-tauri/windows/installer.nsi'), 'utf8');

const LEGACY_ID = 'com.radiancelux.coauthor';
const CURRENT_APPDATA = 'RmDir /r "$APPDATA\\${BUNDLEID}"';
const CURRENT_LOCAL = 'RmDir /r "$LOCALAPPDATA\\${BUNDLEID}"';
const LEGACY_APPDATA = `RmDir /r "$APPDATA\\${LEGACY_ID}"`;
const LEGACY_LOCAL = `RmDir /r "$LOCALAPPDATA\\${LEGACY_ID}"`;

/** Runtime LogicLib block that starts at `start`, ignoring `${IfThen}` one-liners. */
function logicBlock(source: string, start: number): string {
  const lines = source.slice(start).split('\n');
  let depth = 0;
  const kept: string[] = [];
  for (const line of lines) {
    const code = line.replace(/;.*/, '');
    if (!/\$\{IfThen\}/.test(code)) {
      depth += code.match(/\$\{If\}/g)?.length ?? 0;
    }
    kept.push(line);
    depth -= code.match(/\$\{EndIf\}/g)?.length ?? 0;
    if (kept.length > 1 && depth === 0) break;
  }
  if (depth !== 0) {
    throw new Error('unbalanced ${If} / ${EndIf} while reading the uninstall delete block');
  }
  return kept.join('\n');
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('uninstall delete-data and pre-rename folders (#352)', () => {
  const deleteAt = NSI.indexOf('${If} $DeleteAppDataCheckboxState = 1');
  const deleteBlock = logicBlock(NSI, deleteAt);

  it('removes current and pre-rename folders only on the checked, non-update path', () => {
    expect(deleteAt).toBeGreaterThanOrEqual(0);
    expect(NSI.indexOf('${If} $DeleteAppDataCheckboxState = 1', deleteAt + 1)).toBe(-1);
    expect(deleteBlock).toContain('${AndIf} $UpdateMode <> 1');
    expect(count(deleteBlock, CURRENT_APPDATA)).toBe(1);
    expect(count(deleteBlock, CURRENT_LOCAL)).toBe(1);
    expect(count(deleteBlock, LEGACY_APPDATA)).toBe(1);
    expect(count(deleteBlock, LEGACY_LOCAL)).toBe(1);

    const outside = NSI.replace(deleteBlock, '');
    for (const line of [CURRENT_APPDATA, CURRENT_LOCAL, LEGACY_APPDATA, LEGACY_LOCAL]) {
      expect(outside, line).not.toContain(line);
    }
    expect(outside).not.toMatch(/RmDir[^\n]*com\.radiancelux\.coauthor/i);
  });

  it('spells the pre-rename identifier as a literal and keeps the BUNDLEID guard', () => {
    const legacyLines = deleteBlock
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('RmDir') && line.includes(LEGACY_ID));
    expect(legacyLines).toEqual([LEGACY_APPDATA, LEGACY_LOCAL]);
    for (const line of legacyLines) {
      expect(line).not.toContain('${BUNDLEID}');
      expect(line).not.toContain('{{bundle_id}}');
    }
    expect(deleteBlock).toContain('!if "${BUNDLEID}" == "com.radiancelux.coauthor"');
    expect(deleteBlock).toContain(
      '!error "swarmDraft: BUNDLEID must not be the pre-rename identifier. Those folders are removed only by the literal name on this checked, non-update path."',
    );
    expect(NSI).not.toContain(
      '!error "swarmDraft: the uninstaller must never delete the pre-rename data folders"',
    );
  });

  it('keeps honest finish copy for a checked and an unchecked uninstall', () => {
    const start = NSI.indexOf('Function un.ObFinishCreate');
    const end = NSI.indexOf('FunctionEnd', start);
    const finish = NSI.slice(start, end);
    const checked = finish.indexOf('StrCpy $1 "The app and its data are gone from this computer."');
    const otherwise = finish.indexOf('${Else}');
    const kept = finish.indexOf(
      'StrCpy $1 "Your manuscripts are still on this computer. They\'ll be there if you install swarmDraft again."',
    );
    expect(finish.slice(0, checked)).toContain('$DeleteAppDataCheckboxState = ${BST_CHECKED}');
    expect(checked).toBeGreaterThan(-1);
    expect(checked).toBeLessThan(otherwise);
    expect(otherwise).toBeLessThan(kept);
    expect(NSI).toContain(
      '${NSD_CreateCheckbox} 26u 134u 280u 14u "Also delete my manuscripts and settings"',
    );
  });
});
