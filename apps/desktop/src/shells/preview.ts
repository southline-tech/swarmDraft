/** Preview routing for the UI shells: `?preview=<id>` (or `all`) and optional `&theme=dark`. */
export const SCREENS = [
  { id: 'wp1', label: 'wp1/wp6 · Editor with review (sample)' },
  { id: 'wp2', label: 'wp2 · Sidebars collapsed (sample)' },
  { id: 'wp8', label: 'wp8 · Review step-through (sample)' },
  { id: 'tc4', label: 'tc4/tc6 · Review changes by author (sample)' },
  { id: 'tc3', label: 'tc3 · Name & color prompt' },
  { id: 'tc5', label: 'tc5 · Settings: Your name & color' },
  { id: 'ob6', label: 'ob6 · Opening progress' },
  { id: 'ob7', label: 'ob7 · Toast' },
  { id: 'ob8', label: 'ob8 · Empty states' },
  { id: 'ob9', label: 'ob9 · Errors & save-failure banner' },
  { id: 'reason', label: '#60 · Reason line on bot cards' },
] as const;
export type ScreenId = (typeof SCREENS)[number]['id'];

export function readPreview(search: string): ScreenId | 'all' | null {
  const v = new URLSearchParams(search).get('preview');
  if (v === 'all') return 'all';
  return SCREENS.some((s) => s.id === v) ? (v as ScreenId) : null;
}

export function applyThemeParam(search: string, root: HTMLElement) {
  const t = new URLSearchParams(search).get('theme');
  if (t === 'dark' || t === 'light') root.dataset.theme = t;
}
