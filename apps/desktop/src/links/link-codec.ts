/** `swarmdraft://open?draft=<manuscriptId>&change=<changeId>` (#117). */

export const COPY_LINK_SUCCESS = 'Link copied. Paste it anywhere to come back to this change.';
export const COPY_LINK_FAILURE = "Couldn't copy the link. Try again.";
export const COPY_LINK_DISABLED_REASON = 'Right-click a suggested change to copy a link to it.';

export interface ChangeLink {
  manuscriptId: string;
  changeId: string;
}

export function encodeChangeLink(manuscriptId: string, changeId: string): string {
  return `swarmdraft://open?draft=${encodeURIComponent(manuscriptId)}&change=${encodeURIComponent(changeId)}`;
}

/** A usable change link, or null when the URL is missing, mistyped, or blank. */
export function parseChangeLink(raw: string): ChangeLink | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'swarmdraft:') return null;
  const host = (url.hostname || url.host).replace(/\/$/, '');
  if (host.toLowerCase() !== 'open') return null;
  const manuscriptId = url.searchParams.get('draft')?.trim() ?? '';
  const changeId = url.searchParams.get('change')?.trim() ?? '';
  if (!manuscriptId || !changeId) return null;
  return { manuscriptId, changeId };
}

export async function writeChangeLink(
  manuscriptId: string,
  changeId: string,
  writeText: (text: string) => Promise<void> = defaultWriteText,
): Promise<boolean> {
  const url = encodeChangeLink(manuscriptId, changeId);
  try {
    await writeText(url);
    return true;
  } catch (err) {
    console.error('Copy link failed', err);
    return false;
  }
}

function defaultWriteText(text: string): Promise<void> {
  const write = navigator.clipboard?.writeText?.bind(navigator.clipboard);
  if (!write) return Promise.reject(new Error('Clipboard is not available'));
  return write(text);
}
