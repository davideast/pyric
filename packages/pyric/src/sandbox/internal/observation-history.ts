/** Shared count and byte bounds; elapsed time must not make replay history incomplete. */
export const OBSERVATION_HISTORY_LIMITS = {
  maxEvents: 10_000,
  maxBytes: 8 * 1024 * 1024,
} as const;
