import { readEvidenceQuery } from './evidence-routes';

/** Designer evidence (#67): `?evidence=rad67&frame=wp1|wp2|wp8` on the real App shell. */
export type Rad67Frame = 'wp1' | 'wp2' | 'wp8';

export function isRad67Evidence(search: string): boolean {
  return readEvidenceQuery(search) === 'rad67';
}

export function readRad67Frame(search: string): Rad67Frame {
  const v = new URLSearchParams(search).get('frame');
  if (v === 'wp2' || v === 'wp8') return v;
  return 'wp1';
}
