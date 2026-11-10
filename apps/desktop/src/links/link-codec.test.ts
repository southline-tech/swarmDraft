import { describe, expect, it } from 'vitest';
import { encodeChangeLink, parseChangeLink, writeChangeLink } from './link-codec';

describe('change link codec (#117)', () => {
  it('round-trips a manuscript and change id', () => {
    const url = encodeChangeLink('ms 1', 'chg/1');
    expect(url).toBe('swarmdraft://open?draft=ms%201&change=chg%2F1');
    expect(parseChangeLink(url)).toEqual({ manuscriptId: 'ms 1', changeId: 'chg/1' });
    expect(parseChangeLink('swarmdraft://open/?draft=book&change=chg-9')).toEqual({
      manuscriptId: 'book',
      changeId: 'chg-9',
    });
  });

  it('rejects malformed links', () => {
    expect(parseChangeLink('https://example.com/?draft=ms&change=chg')).toBeNull();
    expect(parseChangeLink('swarmdraft://open?draft=ms')).toBeNull();
    expect(parseChangeLink('swarmdraft://open?draft=&change=chg')).toBeNull();
    expect(parseChangeLink('swarmdraft://other?draft=ms&change=chg')).toBeNull();
    expect(parseChangeLink('not a link')).toBeNull();
    expect(parseChangeLink([] as unknown as string)).toBeNull();
  });

  it('writes the encoded url', async () => {
    const written: string[] = [];
    const ok = await writeChangeLink('book-1', 'chg-1', async (text) => {
      written.push(text);
    });
    expect(ok).toBe(true);
    expect(written).toEqual(['swarmdraft://open?draft=book-1&change=chg-1']);
  });
});
