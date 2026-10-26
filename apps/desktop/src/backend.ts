import { invoke, isTauri } from '@tauri-apps/api/core';

export interface AppInfo {
  version: string;
  dataDir: string;
  schemaVersion: number;
}

/** Ask the Rust side for basic app info; returns null in a plain browser (pnpm dev:web). */
export async function getAppInfo(): Promise<AppInfo | null> {
  if (!isTauri()) return null;
  return invoke<AppInfo>('app_info');
}

/** Agent principal (RAD-205). Mirrors `agents::Agent` in Rust. */
export interface Agent {
  id: string;
  name: string;
  color: string;
  createdAt: string;
  revokedAt: string | null;
}

export const AGENT_SCOPES = ['read', 'comment', 'suggest'] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export interface TokenInfo {
  id: string;
  agentId: string;
  prefix: string;
  scopes: AgentScope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** `token` is only ever returned here, once; the backend stores a hash. */
export interface NewToken {
  token: string;
  info: TokenInfo;
}

export const agentsApi = {
  list: () => invoke<Agent[]>('agents_list'),
  create: (name: string, color: string) => invoke<Agent>('agent_create', { name, color }),
  revoke: (agentId: string) => invoke<void>('agent_revoke', { agentId }),
  tokens: (agentId: string) => invoke<TokenInfo[]>('agent_tokens_list', { agentId }),
  createToken: (agentId: string, scopes?: AgentScope[]) =>
    invoke<NewToken>('agent_token_create', { agentId, scopes }),
  revokeToken: (tokenId: string) => invoke<void>('agent_token_revoke', { tokenId }),
};
export type AgentsApi = typeof agentsApi;
