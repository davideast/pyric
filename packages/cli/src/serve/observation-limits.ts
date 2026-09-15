/** Served activity retention; direct SDK history and undo state have separate contracts. */
export const SERVE_HISTORY_LIMITS = { maxEvents: 10_000, maxBytes: 8 * 1024 * 1024 };
