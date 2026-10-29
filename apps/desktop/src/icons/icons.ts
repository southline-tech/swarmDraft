/** Path data for the shared 16px line icon set (see AppIcon.vue). */
export const ICONS = {
  menu: ['M3 4.5h10', 'M3 8h10', 'M3 11.5h10'],
  'arrow-up': ['M8 13V3', 'M4 7l4-4 4 4'],
  'arrow-down': ['M8 3v10', 'M4 9l4 4 4-4'],
  plus: ['M8 3v10', 'M3 8h10'],
  book: [
    'M3 3.5h4a1 1 0 0 1 1 1V13a1 1 0 0 0-1-1H3z',
    'M13 3.5H9a1 1 0 0 0-1 1V13a1 1 0 0 1 1-1h4z',
  ],
  settings: [
    'M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z',
    'M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1',
  ],
  check: ['M4 8.5 6.5 11 12 5'],
  sparkle: [
    'M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2M4.2 4.2l1.4 1.4M10.4 10.4l1.4 1.4M4.2 11.8l1.4-1.4M10.4 5.6l1.4-1.4',
  ],
} as const satisfies Record<string, readonly string[]>;

export type IconName = keyof typeof ICONS;
