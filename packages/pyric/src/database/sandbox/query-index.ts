/**
 * Index enforcement for RTDB queries ordered by a child or by value.
 *
 * Production behavior (oracle `rtdb-modular-query-index-enforcement`):
 *   - `get()` of a query whose ordering has no matching `.indexOn` rejects
 *     with a plain `Error` (no `code`) carrying {@link indexNotDefined}'s
 *     message, with or without a limit or range.
 *   - A listener on the same query is not rejected. The client downloads the
 *     location and filters it locally. When the query has a limit or a range,
 *     the client logs {@link unspecifiedIndexWarning}; an unlimited, unbounded
 *     query logs nothing.
 *   - `orderByKey`, `orderByPriority` and the default ordering need no index.
 */
import type { QuerySpec } from '../internal/query-projection.js';

function displayPath(path: string): string {
  return '/' + path.split('/').filter(Boolean).join('/');
}

/** The rejection a `get()` of an unindexed query raises. */
export function indexNotDefined(path: string, index: string): Error {
  return new Error(
    `Index not defined, add ".indexOn": "${index}", for path "${displayPath(path)}", to the rules`,
  );
}

/** True when the query reads the whole location: no limit and no range. */
export function loadsAllData(spec: QuerySpec): boolean {
  return spec.limit === null && spec.bounds.length === 0;
}

/** The warning text a listener on an unindexed, limited or ranged query logs. */
export function unspecifiedIndexWarning(path: string, index: string): string {
  return 'Using an unspecified index. Your data will be downloaded and filtered on the client. ' +
    `Consider adding ".indexOn": "${index}" at ${displayPath(path)} to your security rules for better performance.`;
}

/** Log a database warning in the format `firebase/database` uses. */
export function logDatabaseWarning(message: string): void {
  console.warn(`[${new Date().toISOString()}]  @firebase/database:`, `FIREBASE WARNING: ${message} `);
}
