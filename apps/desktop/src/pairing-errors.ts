import { rawErrorText } from './errors/map-error';

/** #270: map duplicate agent name errors to author-facing copy. */
export function pairingNameCollisionMessage(err: unknown): string | null {
  const raw = rawErrorText(err);
  const m = raw.match(/an agent named "([^"]+)" already exists/i);
  if (m) {
    return `A bot named ${m[1]} already exists. Choose another name or revoke the existing agent in Settings › Agents.`;
  }
  return null;
}
