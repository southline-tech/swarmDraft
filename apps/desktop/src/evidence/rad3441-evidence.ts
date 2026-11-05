/** Pilot gate / release checklist evidence (#34, #41): `?evidence=34-41&frame=…`. */
export const RAD3441_FRAMES = [
  'welcome',
  'import',
  'opening-progress',
  'editor',
  'save-status',
  'update-prompt',
  'error-card',
  'empty-states',
  'export-settings',
  'agents',
] as const;

export type Rad3441Frame = (typeof RAD3441_FRAMES)[number];

export function readRad3441Frame(search: string): Rad3441Frame {
  const v = new URLSearchParams(search).get('frame');
  return RAD3441_FRAMES.includes(v as Rad3441Frame) ? (v as Rad3441Frame) : 'welcome';
}
