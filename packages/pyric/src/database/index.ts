/**
 * `pyric/database` — sandbox-only mirror of `firebase/database`.
 *
 * Production selection happens before this module loads: canonical
 * `firebase/database` imports either remain Firebase or are swapped to this
 * package by the Vite/import-map or Node register boundary.
 */
export { TARGET_SYMBOL } from './routing.js';
export * from './database-types.js';
export { QUERY_SYMBOL, type Query, type QueryConstraint } from './query-types.js';
export * from './instances.js';
export * from './references.js';
export * from './operations.js';
export * from './listeners.js';
export * from './queries.js';
export * from './transactions.js';
export * from './sentinels.js';
export * from './on-disconnect.js';
export * from './controls.js';
export * from './sandbox-namespace.js';
