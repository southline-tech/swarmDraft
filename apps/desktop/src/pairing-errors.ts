import { rawErrorText } from './errors/map-error';
import { pairing } from './copy-deck';

/** #270: map duplicate agent name errors to author-facing copy. */
export function pairingNameCollisionMessage(err: unknown): string | null {
  const raw = rawErrorText(err);
  const m = raw.match(/an agent named "([^"]+)" already exists/i);
  if (m?.[1]) {
    return pairing.nameCollision(m[1]);
  }
  return null;
}
