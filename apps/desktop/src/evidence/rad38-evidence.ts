/** Designer evidence (#38): `?evidence=38-notes&frame=empty|filled`. */
export type Rad38Frame = 'empty' | 'filled';

export function readRad38Frame(search: string): Rad38Frame {
  const v = new URLSearchParams(search).get('frame');
  return v === 'filled' ? 'filled' : 'empty';
}
