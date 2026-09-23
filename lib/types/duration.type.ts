// Copied from packages/workflows/src/duration.ts (the family's shared duration format).

/** Milliseconds, or a string such as `"250ms"`, `"30s"`, `"15m"`, `"6h"`, `"3d"`, `"1w"`. */
export type Duration =
  number | `${number}${'ms' | 's' | 'm' | 'h' | 'd' | 'w'}`;
