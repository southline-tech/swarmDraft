import { invoke } from '@tauri-apps/api/core';

/** Mirrors `pairing::PairingSummary` in Rust (camelCase over IPC). */
export interface PairingSummary {
  id: string;
  name: string;
  color: string;
  requestedScopes: string[];
  createdAt: string;
  expiresAt: string;
}

export interface PairingApi {
  listPending: () => Promise<PairingSummary[]>;
  approve: (pairingId: string, scopes?: string[]) => Promise<void>;
  deny: (pairingId: string) => Promise<void>;
}

export const pairingApi: PairingApi = {
  listPending: () => invoke<PairingSummary[]>('list_pending_pairings'),
  approve: (pairingId, scopes) => invoke('approve_pairing', { pairingId, scopes: scopes ?? null }),
  deny: (pairingId) => invoke('deny_pairing', { pairingId }),
};
