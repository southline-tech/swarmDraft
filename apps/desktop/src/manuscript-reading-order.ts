import { buildOutline, type OutlineNode } from '@coauthor/editor';
import type { Section } from '@coauthor/schema';

/** Outline sections in reading order (depth-first), for one continuous scroll. */
export function sectionsInReadingOrder(sections: readonly Section[]): Section[] {
  const out: Section[] = [];
  const walk = (nodes: OutlineNode[]) => {
    for (const { children, ...section } of nodes) {
      out.push(section);
      walk(children);
    }
  };
  walk(buildOutline(sections));
  return out;
}
