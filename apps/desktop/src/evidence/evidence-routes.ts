/** Dev-only PR screenshot harnesses (`?evidence=…`). Stripped from production builds. */
export function readEvidenceQuery(search: string): string | null {
  if (!import.meta.env.DEV) return null;
  return new URLSearchParams(search).get('evidence');
}

export function isEvidenceRoute(search: string, route: string): boolean {
  return readEvidenceQuery(search) === route;
}
