/** Thrown when the writer cancels an in-flight .docx import (#299). */
export class ImportCancelledError extends Error {
  constructor() {
    super('Import cancelled');
    this.name = 'ImportCancelledError';
  }
}
