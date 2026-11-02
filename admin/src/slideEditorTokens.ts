/**
 * Surfaces of the slide editor (a three-column workspace). They sit outside
 * the MUI palette in `theme.ts` because they are specific to that screen: a
 * neutral grey ground under the slide, a warm rail for the sequence, and two
 * border weights. Kept apart from `theme.ts` so components that only need
 * these stay free of the react-admin theme import.
 */
export const slideEditorTokens = {
  ground: "#EBE7E1",
  rail: "#FAF8F5",
  border: "#ECE7DF",
  borderStrong: "#D9D2C7",
  ink: "#1F1D1B",
  muted: "#6B645D",
} as const;
