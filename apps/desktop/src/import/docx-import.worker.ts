import * as Y from 'yjs';
import { importDocx, importedToYDocs, type ImportOptions } from '@swarmdraft/docx';

export type WorkerImportRequest = {
  bytes: ArrayBuffer;
  options: ImportOptions;
};

export type WorkerImportOk = {
  type: 'ok';
  imported: ReturnType<typeof importDocx>;
  ydocs: {
    manuscriptUpdate: ArrayBuffer;
    sectionUpdates: Record<string, ArrayBuffer>;
  };
};

export type WorkerImportErr = { type: 'error'; message: string };

self.onmessage = (event: MessageEvent<WorkerImportRequest>) => {
  try {
    const { bytes, options } = event.data;
    const imported = importDocx(new Uint8Array(bytes), options);
    const { manuscript, sections } = importedToYDocs(imported);
    const manuscriptUpdate = Y.encodeStateAsUpdate(manuscript);
    const sectionUpdates: Record<string, ArrayBuffer> = {};
    const transfers: Transferable[] = [manuscriptUpdate.buffer];
    for (const [docId, doc] of sections) {
      const update = Y.encodeStateAsUpdate(doc);
      sectionUpdates[docId] = update.buffer;
      transfers.push(update.buffer);
    }
    const payload: WorkerImportOk = {
      type: 'ok',
      imported,
      ydocs: { manuscriptUpdate: manuscriptUpdate.buffer, sectionUpdates },
    };
    (
      self as unknown as { postMessage(data: WorkerImportOk, transfer: Transferable[]): void }
    ).postMessage(payload, transfers);
  } catch (err) {
    const payload: WorkerImportErr = {
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as { postMessage(data: WorkerImportErr): void }).postMessage(payload);
  }
};
