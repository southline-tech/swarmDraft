export type Rad310Frame = 'available' | 'progress' | 'up-to-date';

export function readRad310Frame(search: string): Rad310Frame {
  const frame = new URLSearchParams(search).get('frame');
  if (frame === 'progress' || frame === 'up-to-date') return frame;
  return 'available';
}
