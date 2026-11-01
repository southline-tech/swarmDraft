/**
 * Outline titles for UI/tests (#111): optional names without chapter/part prefixes.
 * `@swarmdraft/docx` import tests keep Word heading text; numbers come from numbering style.
 */
export const MOCK_OUTLINE_DISPLAY_TITLES: Readonly<Record<string, string>> = {
  'Part One: The Bell That Stopped': 'The Bell That Stopped',
  'Part Two: Salt and Lamplight': 'Salt and Lamplight',
  'Part Three: The Twelfth Boat': 'The Twelfth Boat',
  'Chapter 1: Low Tide': 'Low Tide',
  'Chapter 2': 'Stillwater',
  'CHAPTER THREE': 'Night rounds',
  'Chapter 4: The Ledger': 'The Ledger',
  'Chapter 5': 'Salt wind',
  'CHAPTER SIX': 'Lamplight',
  'Chapter 7': 'Harbor count',
  'CHAPTER EIGHT': 'Blue hour',
  'Chapter 9: Blue Flame': 'Blue Flame',
  'CHAPTER TEN': 'Tenth boat',
  'Chapter 11': 'Last watch',
  'Chapter 12: Morning, Finally': 'Morning, Finally',
};

export function mockOutlineDisplayTitle(importTitle: string): string {
  return MOCK_OUTLINE_DISPLAY_TITLES[importTitle] ?? importTitle;
}
