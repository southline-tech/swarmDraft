/** User-facing scope chips for the MCP pairing dialog (ap1). */

const ACCESS_LABEL: Record<string, string> = {
  suggest: 'Suggest changes',
  comment: 'Comment',
  read: 'Read',
};

const ACCESS_ORDER = ['suggest', 'comment', 'read'] as const;

export function pairingAccessChips(scopes: string[]): string[] {
  return ACCESS_ORDER.filter((s) => scopes.includes(s)).map((s) => ACCESS_LABEL[s] ?? s);
}
