/**
 * Open a change link: focus a live or moved change, or show the read-only history view.
 * Unknown ids stay on the manuscript with a toast (#117, #123).
 */
import { isTauri } from '@tauri-apps/api/core';
import {
  linksResolve,
  linksTakeLaunchUrl,
  listenChangeLinks,
  type LinkResolution,
} from '../backend';
import { parseChangeLink } from './link-codec';

export const UNKNOWN_CHANGE_TOAST =
  "That change isn't in this book's history. Your book is open where you left off.";

export type { LinkResolution };

export interface OldChangeViewModel {
  manuscriptId: string;
  changeId: string;
  sectionId: string;
  quote: string;
  kind: string;
  authorName: string;
  outcome: string;
  decidedBy: string;
  decidedAt: number | null;
}

export interface ChangeLinkRoute {
  ensureManuscript: (manuscriptId: string) => Promise<boolean>;
  /** Scroll and focus via the continuous review nav. */
  focusChange: (sectionId: string, changeId: string) => Promise<void>;
  showHistory: (view: OldChangeViewModel) => void;
  showToast: (message: string) => void;
  clearOpenError: () => void;
  onFailure: (err: unknown) => void;
}

type Resolver = (manuscriptId: string, changeId: string) => Promise<LinkResolution | null>;

export async function openChangeLink(
  raw: string,
  route: ChangeLinkRoute,
  resolve: Resolver = linksResolve,
): Promise<'invalid' | 'opened' | 'failed'> {
  const parsed = parseChangeLink(raw);
  if (!parsed) return 'invalid';
  let resolution: LinkResolution | null;
  try {
    resolution = await resolve(parsed.manuscriptId, parsed.changeId);
  } catch (err) {
    route.onFailure(err);
    return 'failed';
  }
  if (!resolution) return 'failed';
  let opened = false;
  try {
    opened = await route.ensureManuscript(resolution.manuscriptId);
  } catch (err) {
    console.error('Change link open failed', err);
    route.onFailure(err);
    return 'failed';
  }
  if (!opened) return 'failed';
  route.clearOpenError();
  if (resolution.action === 'focus') {
    await route.focusChange(resolution.sectionId, resolution.changeId);
    return 'opened';
  }
  if (resolution.action === 'history') {
    route.showHistory({
      manuscriptId: resolution.manuscriptId,
      changeId: resolution.changeId,
      sectionId: resolution.sectionId,
      quote: resolution.quote,
      kind: resolution.kind,
      authorName: resolution.authorName,
      outcome: resolution.outcome,
      decidedBy: resolution.decidedBy,
      decidedAt: resolution.decidedAt,
    });
    return 'opened';
  }
  route.showToast(UNKNOWN_CHANGE_TOAST);
  return 'opened';
}

/** Cold start plus later opens (single-instance and the deep-link plugin). */
export function startChangeLinkRoute(route: ChangeLinkRoute): () => void {
  if (!isTauri()) return () => {};
  let stop = () => {};
  let stopped = false;
  const seen = new Map<string, number>();
  const deliver = (url: string) => {
    const now = Date.now();
    const prev = seen.get(url) ?? 0;
    if (now - prev < 2000) return;
    seen.set(url, now);
    void openChangeLink(url, route);
  };
  void (async () => {
    try {
      // Subscribe first. On macOS the launch URL is stored and emitted from the same
      // Opened event; taking it before the listener drops a cold-start link in that gap.
      const unlisten = await listenChangeLinks(deliver);
      if (stopped) {
        unlisten();
        return;
      }
      stop = unlisten;
      const launch = await linksTakeLaunchUrl();
      if (!stopped && launch) deliver(launch);
    } catch (err) {
      console.error('Change link route failed', err);
    }
  })();
  return () => {
    stopped = true;
    stop();
  };
}
