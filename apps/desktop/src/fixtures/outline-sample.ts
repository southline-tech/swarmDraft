import type { Section } from '@coauthor/schema';
import { addSection } from '@coauthor/editor';

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
  add('part-1', 'part', 'Part One');
  add('ch-1', 'chapter', 'Chapter 1', 'part-1');
  add('ch-2', 'chapter', 'Chapter 2', 'part-1');
  add('about', 'back_matter', 'About the author');
  return s;
}
