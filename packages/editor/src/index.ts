/**
 * Editor package: Tiptap editor, Yjs binding, local persistence and the
 * parts/chapters/scenes outline live here (RAD-202, RAD-203, RAD-214).
 */
import type { Section } from '@coauthor/schema';

export type OutlineNode = Section & { children: OutlineNode[] };

export * from './comments';
