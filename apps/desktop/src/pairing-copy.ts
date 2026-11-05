/** User-facing scope chips for the pairing dialog (ap1). */
import { pairing } from './copy-deck';

const ACCESS_LABEL: Record<string, string> = {
  suggest: pairing.accessSuggest,
  comment: pairing.accessComment,
  read: pairing.accessRead,
};

const ACCESS_ORDER = ['suggest', 'comment', 'read'] as const;

export function pairingAccessChips(scopes: string[]): string[] {
  return ACCESS_ORDER.filter((s) => scopes.includes(s)).map((s) => ACCESS_LABEL[s] ?? s);
}
