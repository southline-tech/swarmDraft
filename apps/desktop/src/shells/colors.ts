/** The eight collaborator swatches from the design system (tc5). Names only; colors are tokens. */
export const SWATCHES = [
  { id: 1, name: 'Blue' },
  { id: 2, name: 'Rust' },
  { id: 3, name: 'Green' },
  { id: 4, name: 'Purple' },
  { id: 5, name: 'Rose' },
  { id: 6, name: 'Gold' },
  { id: 7, name: 'Teal' },
  { id: 8, name: 'Slate' },
] as const;
export const swatchVar = (id: number) => `var(--ct-collab-${id})`;
