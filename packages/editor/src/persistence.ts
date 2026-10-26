/**
 * Local persistence and autosave for per-section Yjs documents (RAD-203).
 *
 * Every section has its own Y.Doc. Edits are batched (debounced, with a maximum wait) and
 * appended to the desktop store as one Yjs update; the store keeps an append-only log per
 * document and compacts it. `pull()` fetches anything newer in the store, such as a comment or
 * suggestion an agent added through the MCP server, as a diff against this doc's state vector.
 * No network service is involved: the backend is the local SQLite store (Tauri commands).
 */
import * as Y from 'yjs';

export interface DocBackend {
  /** Yjs v1 update with everything in the stored doc that `stateVector` has not seen. */
  diff(docId: string, stateVector: Uint8Array): Promise<Uint8Array>;
  /** Append one Yjs v1 update to the stored doc. */
  append(docId: string, update: Uint8Array): Promise<void>;
}

export type SaveStatus = 'loading' | 'saved' | 'pending' | 'saving' | 'error';

export interface PersistenceOptions {
  /** Quiet time after the last edit before saving. */
  debounceMs?: number;
  /** Longest an edit waits while typing continues. */
  maxWaitMs?: number;
  /** First retry delay after a failed save (doubles, capped at 30 s). */
  retryMs?: number;
  onStatus?: (status: SaveStatus, error?: unknown) => void;
}

export class SectionPersistence {
  readonly docId: string;
  readonly doc: Y.Doc;
  status: SaveStatus = 'loading';
  lastError: unknown = undefined;

  private readonly backend: DocBackend;
  private readonly opts: Required<Omit<PersistenceOptions, 'onStatus'>> &
    Pick<PersistenceOptions, 'onStatus'>;
  private pending: Uint8Array[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private firstPendingAt = 0;
  private saving: Promise<void> | undefined;
  private retryDelay: number;
  private destroyed = false;
  private readonly onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this || this.destroyed) return;
    this.pending.push(update);
    if (!this.firstPendingAt) this.firstPendingAt = Date.now();
    this.setStatus('pending');
    this.schedule();
  };

  constructor(docId: string, doc: Y.Doc, backend: DocBackend, opts: PersistenceOptions = {}) {
    this.docId = docId;
    this.doc = doc;
    this.backend = backend;
    this.opts = {
      debounceMs: opts.debounceMs ?? 800,
      maxWaitMs: opts.maxWaitMs ?? 5000,
      retryMs: opts.retryMs ?? 1000,
      onStatus: opts.onStatus,
    };
    this.retryDelay = this.opts.retryMs;
    doc.on('update', this.onUpdate);
  }

  /** Load the stored document into `doc`. Local edits made meanwhile are kept and saved. */
  async load(): Promise<void> {
    const update = await this.backend.diff(this.docId, new Uint8Array());
    if (update.length) Y.applyUpdate(this.doc, update, this);
    this.setStatus(this.pending.length ? 'pending' : 'saved');
  }

  /** Apply anything in the store this doc has not seen yet (e.g. an agent's suggestion). */
  async pull(): Promise<void> {
    const update = await this.backend.diff(this.docId, Y.encodeStateVector(this.doc));
    if (update.length > 2) Y.applyUpdate(this.doc, update, this);
  }

  /** Save all pending edits now. Resolves once they are stored (or rejects on failure). */
  async flush(): Promise<void> {
    this.clearTimer();
    if (this.saving) await this.saving.catch(() => undefined);
    if (!this.pending.length) return;
    const batch = this.pending;
    this.pending = [];
    this.firstPendingAt = 0;
    const update = batch.length === 1 ? batch[0]! : Y.mergeUpdates(batch);
    this.setStatus('saving');
    this.saving = this.backend.append(this.docId, update);
    try {
      await this.saving;
      this.retryDelay = this.opts.retryMs;
      this.lastError = undefined;
      this.setStatus(this.pending.length ? 'pending' : 'saved');
      if (this.pending.length) this.schedule();
    } catch (e) {
      // Keep the batch (ahead of newer edits) and retry with backoff; nothing is dropped.
      this.pending = [update, ...this.pending];
      if (!this.firstPendingAt) this.firstPendingAt = Date.now();
      this.lastError = e;
      this.setStatus('error', e);
      if (!this.destroyed) {
        this.timer = setTimeout(() => void this.flush().catch(() => undefined), this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
      }
      throw e;
    } finally {
      this.saving = undefined;
    }
  }

  get hasUnsavedChanges(): boolean {
    return this.pending.length > 0 || this.saving !== undefined;
  }

  /** Stop listening after a final save attempt. */
  async destroy(): Promise<void> {
    try {
      await this.flush();
    } finally {
      this.destroyed = true;
      this.clearTimer();
      this.doc.off('update', this.onUpdate);
    }
  }

  private schedule(): void {
    if (this.saving || this.status === 'error') return;
    this.clearTimer();
    const waited = Date.now() - this.firstPendingAt;
    const delay = Math.max(0, Math.min(this.opts.debounceMs, this.opts.maxWaitMs - waited));
    this.timer = setTimeout(() => void this.flush().catch(() => undefined), delay);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private setStatus(s: SaveStatus, e?: unknown): void {
    this.status = s;
    this.opts.onStatus?.(s, e);
  }
}

/** Opens each section's Y.Doc once and keeps its persistence; one Y.Doc per section. */
export class SectionDocs {
  private readonly open_ = new Map<string, Promise<SectionPersistence>>();

  constructor(
    private readonly backend: DocBackend,
    private readonly opts: PersistenceOptions = {},
  ) {}

  open(docId: string, opts: PersistenceOptions = {}): Promise<SectionPersistence> {
    let p = this.open_.get(docId);
    if (!p) {
      const persistence = new SectionPersistence(docId, new Y.Doc({ gc: true }), this.backend, {
        ...this.opts,
        ...opts,
      });
      p = persistence.load().then(() => persistence);
      p.catch(() => this.open_.delete(docId));
      this.open_.set(docId, p);
    }
    return p;
  }

  async flushAll(): Promise<void> {
    const all = await Promise.allSettled([...this.open_.values()]);
    await Promise.all(all.flatMap((r) => (r.status === 'fulfilled' ? [r.value.flush()] : [])));
  }

  async close(docId: string): Promise<void> {
    const p = this.open_.get(docId);
    if (!p) return;
    this.open_.delete(docId);
    const persistence = await p;
    await persistence.destroy();
    persistence.doc.destroy();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.open_.keys()].map((id) => this.close(id)));
  }
}

/** In-memory backend for tests and browser mode (`pnpm dev:web`); nothing touches disk. */
export class MemoryDocBackend implements DocBackend {
  readonly logs = new Map<string, Uint8Array[]>();
  failNext = 0;

  async diff(docId: string, stateVector: Uint8Array): Promise<Uint8Array> {
    const log = this.logs.get(docId) ?? [];
    if (!log.length) return new Uint8Array();
    const merged = Y.mergeUpdates(log);
    return stateVector.length ? Y.diffUpdate(merged, stateVector) : merged;
  }

  async append(docId: string, update: Uint8Array): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('simulated write failure');
    }
    const log = this.logs.get(docId) ?? [];
    log.push(update);
    this.logs.set(docId, log);
  }
}
