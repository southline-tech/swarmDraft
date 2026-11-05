import { readEvidenceQuery } from './evidence-routes';

/** PR evidence (#36): `?evidence=36-wp&frame=…` on the real editor chrome. */
export type Rad36Frame = 'find' | 'find-replace' | 'shortcuts' | 'context-menu' | 'track-on';

export function isRad36Evidence(search: string): boolean {
  return readEvidenceQuery(search) === '36-wp';
}

export function readRad36Frame(search: string): Rad36Frame {
  const f = new URLSearchParams(search).get('frame');
  if (
    f === 'find' ||
    f === 'find-replace' ||
    f === 'shortcuts' ||
    f === 'context-menu' ||
    f === 'track-on'
  ) {
    return f;
  }
  return 'find';
}
