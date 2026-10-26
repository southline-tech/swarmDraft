/**
 * Word .docx import/export (RAD-218). Independent of the editor and MCP code:
 * input is a .docx byte array, output is a structured manuscript (sections with
 * ProseMirror-compatible JSON content), and the reverse for export.
 */
import type { Section } from '@coauthor/schema';

export interface ImportedSection extends Section {
  /** ProseMirror JSON for this section's content. */
  content: unknown;
}

export interface ImportedManuscript {
  title: string;
  sections: ImportedSection[];
  warnings: string[];
}
