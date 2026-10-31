import type { InjectionKey, ShallowRef } from 'vue';

/** Live footer fields synced from the lead ManuscriptEditor when App hosts the status bar. */
export type AppFooterEditorState = {
  wordCount?: number;
  selectionWords?: number;
  trackChanges?: boolean;
  zoom?: number;
  wordsBeforeInDoc?: number;
};

export const APP_FOOTER_EDITOR_KEY: InjectionKey<ShallowRef<AppFooterEditorState>> =
  Symbol('appFooterEditor');
