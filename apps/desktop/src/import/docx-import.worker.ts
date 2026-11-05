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

/** Transfer only the bytes owned by this view (not a larger pooled buffer). */
function transferBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

self.onmessage = (event: MessageEvent<WorkerImportRequest>) => {
  try {
    const { bytes, options } = event.data;
    const imported = importDocx(new Uint8Array(bytes), options);
    const { manuscript, sections } = importedToYDocs(imported);
    const manuscriptUpdate = Y.encodeStateAsUpdate(manuscript);
    const manuscriptBuf = transferBuffer(manuscriptUpdate);
    const sectionUpdates: Record<string, ArrayBuffer> = {};
    const transfers: Transferable[] = [manuscriptBuf];
    for (const [docId, doc] of sections) {
      const update = Y.encodeStateAsUpdate(doc);
      const buf = transferBuffer(update);
      sectionUpdates[docId] = buf;
      transfers.push(buf);
    }
    const payload: WorkerImportOk = {
      type: 'ok',
      imported,
      ydocs: { manuscriptUpdate: manuscriptBuf, sectionUpdates },
    };
    const scope = self as unknown as {
      postMessage(message: WorkerImportOk, transfer: Transferable[]): void;
    };
    scope.postMessage(payload, transfers);
  } catch (err) {
    const payload: WorkerImportErr = {
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as { postMessage(message: WorkerImportErr): void }).postMessage(payload);
  }
};
