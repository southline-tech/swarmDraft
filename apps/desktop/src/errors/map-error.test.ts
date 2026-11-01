import { describe, expect, it } from 'vitest';
import { mapError, rawErrorText, SAVE_OK, saveFailed, saveSucceeded } from './map-error';

describe('mapError', () => {
  const cases: [unknown, string, string][] = [
    [
      'io: The process cannot access the file because it is being used by another process. (os error 32)',
      'open',
      'file-locked',
    ],
    ['sqlite: database is locked', 'save', 'file-locked'],
    ['io: There is not enough space on the disk. (os error 112)', 'save', 'disk-full'],
    ['sqlite: database or disk is full', 'save', 'disk-full'],
    [new Error('ENOSPC: no space left on device, write'), 'export', 'disk-full'],
    ['io: Access is denied. (os error 5)', 'open', 'no-permission'],
    ['sqlite: attempt to write a readonly database', 'save', 'no-permission'],
    [new Error('Not a Word document: word/document.xml missing'), 'import', 'not-word-file'],
    [new Error('Not a valid .docx (zip directory not found)'), 'import', 'not-word-file'],
    [
      new Error('Part word/document.xml checksum mismatch; file is corrupt'),
      'import',
      'file-damaged',
    ],
    ['sqlite: database disk image is malformed', 'open', 'file-damaged'],
    [new Error('File too large (99 bytes; limit 10)'), 'import', 'file-too-large'],
    ['not found: manuscript abc', 'open', 'not-found'],
    ['io: The system cannot find the file specified. (os error 2)', 'open', 'not-found'],
    ['pandoc: offline: could not download Pandoc', 'export', 'pandoc-offline'],
    ['pandoc: checksum: bad zip', 'export', 'pandoc-checksum'],
    ['weird failure', 'save', 'save-failed'],
    ['weird failure', 'export', 'export-failed'],
    ['weird failure', 'import', 'file-damaged'],
    ['weird failure', 'other', 'unknown'],
    [undefined, 'other', 'unknown'],
    [{ message: 'database is locked' }, 'save', 'file-locked'],
  ];
  it.each(cases)('%s (%s) -> %s', (err, ctx, code) => {
    expect(mapError(err, ctx as never).code).toBe(code);
  });

  it('treats UnsavedEditsError as a save failure in any context', async () => {
    const { UnsavedEditsError } = await import('../manuscript-session');
    expect(mapError(new UnsavedEditsError(['s1'], new Error('boom')), 'other').code).toBe(
      'save-failed',
    );
    expect(mapError(new UnsavedEditsError(['s1'], 'sqlite: database is locked')).code).toBe(
      'file-locked',
    );
  });

  it('never leaks raw error text into the copy', () => {
    const raw = 'sqlite: near "SELECT": syntax error at C:\\Users\\kim\\coauthor.db';
    const m = mapError(raw, 'save');
    for (const v of [m.title, m.message, m.actionLabel]) {
      expect(v).not.toContain('sqlite');
      expect(v).not.toContain('C:\\');
    }
  });

  it('uses the ob9 copy and actions', () => {
    expect(mapError('sqlite: database is locked')).toMatchObject({
      title: 'This book is open in another program',
      action: 'try-again',
      actionLabel: 'Try again',
      tone: 'warning',
    });
    expect(mapError('x', 'save')).toMatchObject({
      title: "Your latest changes aren't saved yet",
      action: 'save-a-copy',
      actionLabel: 'Save a copy',
    });
  });

  it('names the missing thing as a file', () => {
    expect(mapError('not found: manuscript abc', 'open').title).toBe("We couldn't find that file");
  });

  it('never throws on hostile or empty values', () => {
    const hostile = {
      toJSON() {
        throw new Error('no');
      },
      toString() {
        throw new Error('no');
      },
    };
    const getter = Object.defineProperty({}, 'message', {
      get() {
        throw new Error('no');
      },
    });
    for (const v of [{ message: Object.create(null) }, hostile, getter, null, undefined]) {
      expect(() => mapError(v)).not.toThrow();
      expect(mapError(v).code).toBe('unknown');
      expect(mapError(v, 'save').code).toBe('save-failed');
    }
    expect(rawErrorText(hostile)).toBe('');
    expect(rawErrorText(null)).toBe('');
    expect(rawErrorText(undefined)).toBe('');
  });

  it('rawErrorText handles any thrown value', () => {
    expect(rawErrorText(new Error('a'))).toBe('a');
    expect(rawErrorText('b')).toBe('b');
    expect(rawErrorText({ x: 1 })).toBe('{"x":1}');
  });
});

describe('save-failure state', () => {
  it('tracks attempts, cause and first-failure time, and clears on success', () => {
    let s = saveFailed(SAVE_OK, 'io: (os error 112)', 1000);
    expect(s).toMatchObject({ failing: true, cause: 'disk-full', attempts: 1, since: 1000 });
    expect(s.error?.code).toBe('save-failed');
    expect(s.error?.action).toBe('save-a-copy');
    s = saveFailed(s, 'boom', 2000);
    expect(s).toMatchObject({ attempts: 2, since: 1000, cause: null });
    expect(saveSucceeded()).toEqual(SAVE_OK);
  });
});
