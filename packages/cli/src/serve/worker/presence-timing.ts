/**
 * Connected-page presence lease timing (#227).
 *
 * Leaf module — safe for both the SharedWorker host and the browser client
 * bundle. Do not import host or sandbox code here.
 */

/** Suggested client heartbeat interval. */
export const PRESENCE_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Lease TTL. Sized to tolerate one delayed background-tab heartbeat under
 * typical timer throttling (~1/min) without falsely evicting a live page.
 */
export const PRESENCE_STALE_MS = 90_000;
