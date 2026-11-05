export type Rad304Frame =
  'context-menu' | 'split-popover' | 'merge-confirm' | 'chapter-toast' | 'split-across-pill';

export function readRad304Frame(search: string): Rad304Frame {
  const f = new URLSearchParams(search).get('frame');
  if (
    f === 'context-menu' ||
    f === 'split-popover' ||
    f === 'merge-confirm' ||
    f === 'chapter-toast' ||
    f === 'split-across-pill'
  ) {
    return f;
  }
  return 'context-menu';
}
