export type SpellIssueKind = 'spelling' | 'grammar';

/** A lint span mapped to document positions (half-open). */
export interface SpellIssue {
  id: string;
  from: number;
  to: number;
  kind: SpellIssueKind;
  message: string;
  suggestions: string[];
  /** Normalized surface word for dictionary / ignore actions. */
  word: string;
}

/** Payload returned from the Harper lint command (per block of plain text). */
export interface SpellLintResult {
  start: number;
  end: number;
  kind: SpellIssueKind;
  message: string;
  suggestions: string[];
}

export type SpellLintFn = (text: string, blockKey: number) => Promise<SpellLintResult[] | null>;

export interface SpellcheckOptions {
  enabled: () => boolean;
  checkSpelling: () => boolean;
  checkGrammar: () => boolean;
  lint: SpellLintFn;
  debounceMs?: number;
}
