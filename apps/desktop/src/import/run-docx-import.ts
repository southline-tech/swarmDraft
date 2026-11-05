import {
  importDocx,
  importedToYDocs,
  type ImportOptions,
  type ImportedManuscript,
} from '@swarmdraft/docx';
import * as Y from 'yjs';
import DocxImportWorker from './docx-import.worker?worker';
import type { WorkerImportErr, WorkerImportOk } from './docx-import.worker';
import { ImportCancelledError } from './import-cancelled';
import { devImportEvidenceDelay } from './dev-import-delay';

export interface ParsedDocxImport {
  imported: ImportedManuscript;
  ydocs: {
    manuscriptUpdate: Uint8Array;
    sectionUpdates: Map<string, Uint8Array>;
  };
}

export interface DocxImportJob {
  abort(): void;
  done: Promise<ParsedDocxImport>;
}

/** Vitest runs imports on the main thread unless a test opts into the worker. */
let forceSyncImport = import.meta.env.MODE === 'test';

export function setForceSyncDocxImport(force: boolean) {
  forceSyncImport = force;
}

function parseSync(bytes: Uint8Array, options: ImportOptions): ParsedDocxImport {
  const imported = importDocx(bytes, options);
  const { manuscript, sections } = importedToYDocs(imported);
  const manuscriptUpdate = Y.encodeStateAsUpdate(manuscript);
  const sectionUpdates = new Map<string, Uint8Array>();
  for (const [docId, doc] of sections) {
    sectionUpdates.set(docId, Y.encodeStateAsUpdate(doc));
  }
  return { imported, ydocs: { manuscriptUpdate, sectionUpdates } };
}

function runInWorker(bytes: Uint8Array, options: ImportOptions): DocxImportJob {
  const worker = new DocxImportWorker();
  let settled = false;
  let rejectDone!: (reason: unknown) => void;

  const done = new Promise<ParsedDocxImport>((resolve, reject) => {
    rejectDone = reject;
    worker.onmessage = (event: MessageEvent<WorkerImportOk | WorkerImportErr>) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      const msg = event.data;
      if (msg.type === 'error') {
        reject(new Error(msg.message));
        return;
      }
      const sectionUpdates = new Map<string, Uint8Array>();
      for (const [docId, buf] of Object.entries(msg.ydocs.sectionUpdates)) {
        sectionUpdates.set(docId, new Uint8Array(buf));
      }
      resolve({
        imported: msg.imported,
        ydocs: {
          manuscriptUpdate: new Uint8Array(msg.ydocs.manuscriptUpdate),
          sectionUpdates,
        },
      });
    };
    worker.onerror = (err) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(err.error ?? err);
    };
    const copy = bytes.slice();
    worker.postMessage({ bytes: copy.buffer, options }, [copy.buffer]);
  });

  return {
    abort() {
      if (settled) return;
      settled = true;
      worker.terminate();
      rejectDone(new ImportCancelledError());
    },
    done,
  };
}

/** Parse a .docx off the UI thread when possible (#299). */
export function runDocxImport(bytes: Uint8Array, options: ImportOptions = {}): DocxImportJob {
  if (forceSyncImport || typeof Worker === 'undefined') {
    let cancelled = false;
    return {
      abort() {
        cancelled = true;
      },
      done: Promise.resolve().then(async () => {
        if (cancelled) throw new ImportCancelledError();
        await devImportEvidenceDelay();
        return parseSync(bytes, options);
      }),
    };
  }
  return runInWorker(bytes, options);
}
