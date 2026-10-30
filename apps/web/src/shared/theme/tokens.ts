/** Motion and layout constants for JS, mirroring the CSS custom properties in globals.css. */
export const motion = {
  fast: 0.12,
  med: 0.22,
  slow: 0.48,
  ease: [0.2, 0.7, 0.2, 1] as const,
  spring: { type: "spring", stiffness: 520, damping: 40, mass: 0.8 } as const,
  /** How long an accepted suggestion takes to "dry" from wash to ink. */
  dryMs: 520,
};

export const layout = {
  /** px, must match --row-height (1.75rem at 16px root). */
  rowHeight: 28,
  colWidth: 136,
  rowHeadWidth: 52,
  rowHeadPad: 18,
  digitWidth: 8,
  hourHeight: 48,
  dayStartHour: 7,
  dayEndHour: 21,
  snapMinutes: 15,
  /** Shorter events show title and start time on one line. */
  compactEventMinutes: 45,
};

export const timing = {
  /** Screen readers hear about streaming text at most this often. */
  announceEveryMs: 1500,
  typingIdleMs: 4000,
  roomIdleCloseMs: 60_000,
  /** Panels derived from a whole document recompute at most this often. */
  deriveEveryMs: 400,
};
