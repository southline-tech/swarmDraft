/** `swarmdraft://open?draft=<manuscriptId>&change=<changeId>` (#117). */

export const COPY_LINK_SUCCESS = 'Link copied. Paste it anywhere to come back to this change.';
export const COPY_LINK_FAILURE = "Couldn't copy the link. Try again.";
export const COPY_LINK_DISABLED_REASON = 'Right-click a suggested change to copy a link to it.';

export interface ChangeLink {
  manuscriptId: string;
  changeId: string;
}

/** Review links refuse a longer list. Matches the MCP tool. */
export const MAX_LINKED_CHANGES = 50;

export interface ReviewLink {
  manuscriptId: string;
  changeIds: string[];
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

export function encodeReviewLink(manuscriptId: string, changeIds: readonly string[]): string {
  const changes = changeIds.map((id) => encodeURIComponent(id)).join(',');
  return `swarmdraft://review?draft=${encodeURIComponent(manuscriptId)}&changes=${changes}`;
}

/** A usable review link, or null when the URL is missing, mistyped, blank, or too long. */
export function parseReviewLink(raw: string): ReviewLink | null {
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
  if (host.toLowerCase() !== 'review') return null;
  const manuscriptId = url.searchParams.get('draft')?.trim() ?? '';
  const changes = url.searchParams.get('changes') ?? '';
  if (!manuscriptId || !changes.trim()) return null;
  const changeIds = changes
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (!changeIds.length || changeIds.length > MAX_LINKED_CHANGES) return null;
  return { manuscriptId, changeIds };
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
