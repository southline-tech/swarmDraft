import { isEvidenceRoute } from './evidence-routes';

/** Designer evidence (#55): `?evidence=rad55&theme=light|dark` — wp5 focus mode on the App shell. */
export function isRad55Evidence(search: string): boolean {
  return isEvidenceRoute(search, 'rad55');
}
