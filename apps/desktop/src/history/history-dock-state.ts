/** Shared right-dock tab state (#365). */

import { usesPrimaryModifier } from '../shells/app-shortcuts';

export type RightDockTab = 'review' | 'history';
export type HistoryActivityTab = 'all' | 'milestones';
/** `all`, `author`, or `agent:<id>` */
export type HistoryFilterKey = 'all' | 'author' | string;

export interface HistoryPanelUiState {
  activityTab: HistoryActivityTab;
  filter: HistoryFilterKey;
  expandedBotRowId: string | null;
  focusedRowKey: string | null;
  compareEntryId: string | null;
}

export function defaultHistoryPanelUi(): HistoryPanelUiState {
  return {
    activityTab: 'all',
    filter: 'all',
    expandedBotRowId: null,
    focusedRowKey: null,
    compareEntryId: null,
  };
}

export function historyToggleShortcut(e: KeyboardEvent): boolean {
  const mod = usesPrimaryModifier(e);
  return mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'h';
}

export function dockToggleShortcut(e: KeyboardEvent): boolean {
  const mod = usesPrimaryModifier(e);
  return mod && !e.shiftKey && !e.altKey && (e.key === '\\' || e.code === 'Backslash');
}

export interface RightDockState {
  open: boolean;
  tab: RightDockTab;
  lastTab: RightDockTab;
}

export function toggleHistoryShortcut(state: RightDockState): RightDockState {
  if (!state.open) {
    return { open: true, tab: 'history', lastTab: 'history' };
  }
  if (state.tab === 'history') {
    return { ...state, open: false, lastTab: 'history' };
  }
  return { open: true, tab: 'history', lastTab: 'history' };
}

export function toggleDockShortcut(state: RightDockState): RightDockState {
  if (state.open) {
    return { open: false, tab: state.tab, lastTab: state.tab };
  }
  const tab = state.lastTab;
  return { open: true, tab, lastTab: tab };
}

export function openDockOnReview(state: RightDockState): RightDockState {
  if (!state.open) return { open: true, tab: 'review', lastTab: 'review' };
  if (state.tab === 'review') return { ...state, open: false, lastTab: 'review' };
  return { open: true, tab: 'review', lastTab: 'review' };
}
