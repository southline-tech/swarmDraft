/** Designer evidence (#55): `?evidence=rad55&theme=light|dark` — wp5 focus mode on the real editor shell. */
export function isRad55Evidence(search: string): boolean {
  return new URLSearchParams(search).get('evidence') === 'rad55';
}
