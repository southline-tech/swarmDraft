import type { Section } from '@swarmdraft/schema';
import { addSection } from '@swarmdraft/editor';

/** Synthetic starter outline shown until a manuscript is opened. */
export const SAMPLE_MANUSCRIPT_ID = 'sample';
export function sampleOutline(): Section[] {
  let s: Section[] = [];
  const add = (id: string, kind: Section['kind'], title: string, parentId?: string) =>
    (s = addSection(s, {
      manuscriptId: SAMPLE_MANUSCRIPT_ID,
      id,
      kind,
      title,
      ...(parentId ? { parentId } : {}),
    }));
  add('title', 'front_matter', 'Title page');
  add('part-1', 'part', 'Opening arc');
  add('ch-1', 'chapter', 'Harbor dawn', 'part-1');
  add('ch-2', 'chapter', 'After the bell', 'part-1');
  add('about', 'back_matter', 'About the author');
  return s;
}
