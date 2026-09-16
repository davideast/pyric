/** Shared observation policy for hosted execution and its browsing surfaces. */
export const OBSERVATION_HISTORY_LIMITS = {
  maxEvents: 10_000,
  maxBytes: 8 * 1024 * 1024,
  maxAgeMs: 30 * 60_000,
} as const;
