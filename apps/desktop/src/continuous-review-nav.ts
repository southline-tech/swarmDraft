import type { InjectionKey } from 'vue';

export type ContinuousReviewNav = {
  /** Scroll the manuscript column to a book-scoped change and select it (#213). */
  navigateToChange: (
    scopedKey: string,
    opts?: { follow?: boolean; suppressSync?: boolean; focusEditor?: boolean },
  ) => Promise<void>;
  /** Pause manuscript→list sync after list-driven scroll (#217). */
  beginSuppressSync: (ms?: number) => void;
  decideInSection: (
    sectionId: string,
    changeKey: string,
    decision: import('@swarmdraft/editor').Decision,
  ) => void;
};

export const CONTINUOUS_REVIEW_NAV: InjectionKey<ContinuousReviewNav> =
  Symbol('continuous-review-nav');

export const CONTINUOUS_SCROLL_ROOT: InjectionKey<{
  root: import('vue').ShallowRef<HTMLElement | null>;
}> = Symbol('continuous-scroll-root');
