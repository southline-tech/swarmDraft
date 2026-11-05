/** Designer / PM evidence (#34 Batch B): `?evidence=34-install&frame=…&theme=light|dark`. */
export const RAD34_FRAMES = [
  'c5-welcome',
  'c7-review-empty',
  'c8-editor-save-failure',
  'status-saved',
  'error-not-word',
  'error-file-locked',
  'error-file-damaged',
  'error-disk-full',
  'error-save-failed',
  'empty-comments',
  'empty-notes',
] as const;

export type Rad34Frame = (typeof RAD34_FRAMES)[number];

export function readRad34Frame(search: string): Rad34Frame {
  const v = new URLSearchParams(search).get('frame');
  return RAD34_FRAMES.includes(v as Rad34Frame) ? (v as Rad34Frame) : 'c5-welcome';
}
