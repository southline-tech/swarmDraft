/**
 * Shared document model types used by the desktop UI, the editor package,
 * and (mirrored in Rust) the in-app MCP server.
 */

export const SECTION_KINDS = ['front_matter', 'part', 'chapter', 'back_matter'] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

export interface Section {
  id: string;
  kind: SectionKind;
  title: string;
  /** Parent section id (chapter -> part). */
  parentId?: string;
  /** Id of this section's own Yjs document (see sectionDocId). */
  docId: string;
}

export type PrincipalKind = 'human' | 'agent';

export interface Principal {
  id: string;
  kind: PrincipalKind;
  displayName: string;
  color: string;
}

export const TRIM_SIZES = {
  '6x9': { widthIn: 6, heightIn: 9 },
  '5.5x8.5': { widthIn: 5.5, heightIn: 8.5 },
} as const;
export type TrimSize = keyof typeof TRIM_SIZES;
export const DEFAULT_TRIM: TrimSize = '6x9';

export function isSectionKind(value: string): value is SectionKind {
  return (SECTION_KINDS as readonly string[]).includes(value);
}

/**
 * Each section has its own Yjs document so it can be loaded,
 * synced, persisted and exposed over MCP independently. The manuscript-level
 * doc only holds metadata and the outline.
 */
export function manuscriptDocId(manuscriptId: string): string {
  return `manuscript/${manuscriptId}`;
}

export function sectionDocId(manuscriptId: string, sectionId: string): string {
  return `manuscript/${manuscriptId}/section/${sectionId}`;
}
export * from './content';
export * from './marks';
