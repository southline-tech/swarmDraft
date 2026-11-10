/**
 * Open a change link: focus a live or moved change, or show the read-only history view.
 * A review link opens the book and filters Review to those changes (#117, #119, #123).
 * Unknown ids stay on the manuscript with a toast.
 */
import { isTauri } from '@tauri-apps/api/core';
import {
  linksResolve,
  linksTakeLaunchUrl,
  listenChangeLinks,
  type LinkResolution,
} from '../backend';
import { parseChangeLink, parseReviewLink } from './link-codec';

export const UNKNOWN_CHANGE_TOAST =
  "That change isn't in this book's history. Your book is open where you left off.";

/**
 * What happens when a review link names changes this book does not have.
 * `missing` is how many ids were unknown. `remaining` is how many were found
 * (still open, or already decided). Shown on the existing link toast.
 */
export function unknownChangesToast(missing: number, remaining: number): string {
  if (remaining > 0) {
    if (missing === 1) {
      return "1 change isn't in this book's history. The others are in your review list.";
    }
    return `${missing} changes aren't in this book's history. The others are in your review list.`;
  }
  if (missing === 1) return UNKNOWN_CHANGE_TOAST;
  return "None of those changes are in this book's history. Your book is open where you left off.";
}

export type { LinkResolution };

export interface OldChangeViewModel {
  manuscriptId: string;
  changeId: string;
  sectionId: string;
  quote: string;
  kind: string;
  /** `agent` when the suggestion came from a bot. */
  authorKind?: string;
  authorName: string;
  outcome: string;
  decidedBy: string;
  decidedAt: number | null;
}

export interface ChangeLinkRoute {
  ensureManuscript: (manuscriptId: string) => Promise<boolean>;
  /** Scroll and focus via the continuous review nav. */
  focusChange: (sectionId: string, changeId: string) => Promise<void>;
  /** One decided change. A review link calls this once per decided id, in link order. */
  showHistory: (view: OldChangeViewModel) => void;
  showToast: (message: string) => void;
  /** Clear a previous link's toast, history view, and review filter. */
  resetLinkUi: () => void;
  /** Filter the review list to these still-open change ids. */
  showSelectedChanges: (changeIds: string[]) => void;
  clearOpenError: () => void;
  onFailure: (err: unknown) => void;
}

function historyModel(
  resolution: Extract<LinkResolution, { action: 'history' }>,
): OldChangeViewModel {
  return {
    manuscriptId: resolution.manuscriptId,
    changeId: resolution.changeId,
    sectionId: resolution.sectionId,
    quote: resolution.quote,
    kind: resolution.kind,
    authorKind: resolution.authorKind,
    authorName: resolution.authorName,
    outcome: resolution.outcome,
    decidedBy: resolution.decidedBy,
    decidedAt: resolution.decidedAt,
  };
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
  route.resetLinkUi();
  if (resolution.action === 'focus') {
    await route.focusChange(resolution.sectionId, resolution.changeId);
    return 'opened';
  }
  if (resolution.action === 'history') {
    route.showHistory(historyModel(resolution));
    return 'opened';
  }
  route.showToast(UNKNOWN_CHANGE_TOAST);
  return 'opened';
}

/**
 * Open a review link: filter Review to the still-open changes.
 * Each decided or no-longer-present change uses the same history view as one edit link.
 * Unknown ids are left out. The toast says whether the rest are in the review
 * list, or that the book stayed where it was.
 */
export async function openReviewLink(
  raw: string,
  route: ChangeLinkRoute,
  resolve: Resolver = linksResolve,
): Promise<'invalid' | 'opened' | 'failed'> {
  const parsed = parseReviewLink(raw);
  if (!parsed) return 'invalid';
  let opened = false;
  try {
    opened = await route.ensureManuscript(parsed.manuscriptId);
  } catch (err) {
    console.error('Review link open failed', err);
    route.onFailure(err);
    return 'failed';
  }
  if (!opened) return 'failed';
  route.clearOpenError();

  const focusIds: string[] = [];
  const history: OldChangeViewModel[] = [];
  let unknown = 0;
  const seen = new Set<string>();
  for (const changeId of parsed.changeIds) {
    if (seen.has(changeId)) continue;
    seen.add(changeId);
    let resolution: LinkResolution | null;
    try {
      resolution = await resolve(parsed.manuscriptId, changeId);
    } catch (err) {
      route.onFailure(err);
      return 'failed';
    }
    if (!resolution || resolution.action === 'unknown') {
      unknown += 1;
      continue;
    }
    if (resolution.action === 'focus') {
      focusIds.push(resolution.changeId);
      continue;
    }
    history.push(historyModel(resolution));
  }

  route.resetLinkUi();
  if (focusIds.length) route.showSelectedChanges(focusIds);
  for (const view of history) route.showHistory(view);
  if (unknown) route.showToast(unknownChangesToast(unknown, focusIds.length + history.length));
  return 'opened';
}

/** Change link or review link. Anything else is invalid. */
export async function openAppLink(
  raw: string,
  route: ChangeLinkRoute,
  resolve: Resolver = linksResolve,
): Promise<'invalid' | 'opened' | 'failed'> {
  if (parseReviewLink(raw)) return openReviewLink(raw, route, resolve);
  return openChangeLink(raw, route, resolve);
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
    void openAppLink(url, route);
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
