/**
 * Word .docx import/export (RAD-218). Independent of the editor and MCP code:
 * input is a .docx byte array, output is a structured manuscript (sections with
 * ProseMirror-compatible JSON content, one Yjs doc per section), and the
 * reverse for export.
 */
export { importDocx, DOCX_LIMITS } from './import';
export type { ImportedComment, ImportedManuscript, ImportedSection, ImportOptions } from './import';
export { exportDocx } from './export';
export { formatReport } from './report';
export type { ImportReport, ImportSummary, ReportItem } from './report';
export {
  docToYDoc,
  yDocToDoc,
  manuscriptToYDocs,
  markKey,
  rekeyMarks,
  REKEY_ORIGIN,
  markTypeFromKey,
  FRAGMENT_NAME,
} from './ydoc';
export * from './model';
export {
  readStructure,
  writeStructure,
  observeStructure,
  importedToYDocs,
  STRUCTURE_FIELD,
  META_FIELD,
  META_NUMBERING_STYLE,
  STRUCTURE_ORIGIN,
  readNumberingStyle,
  writeNumberingStyle,
  type ManuscriptYDocs,
} from './structure';
