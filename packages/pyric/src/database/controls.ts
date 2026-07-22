import { targetOf } from './routing.js';
import type { Database, DatabaseReference } from './types.js';
import { ref } from './references.js';

// ─── Emulator (no-op on sandbox) ─────────────────────────────────────

/**
 * `connectDatabaseEmulator(db, host, port)` is an accepted no-op because the
 * selected backend already is the local sandbox.
 */
export function connectDatabaseEmulator(
  _db: Database,
  _host: string,
  _port: number,
  _options?: { mockUserToken?: string | Record<string, unknown> },
): void {
  // Accepted no-op.
}

// ─── Low-hanging-fruit exports (issue #149) ─────────────────────────
//
// Honest aliases / honest no-ops for `firebase/database` free functions
// that a real app imports at module load.

/**
 * `goOffline(db)` — disconnect the client from the RTDB backend.
 *
 * Drains this client's one-shot onDisconnect queue. The shared data backend
 * remains available to other Database clients and listeners.
 */
export function goOffline(db: Database): void {
  targetOf(db as unknown as object).connection.goOffline();
}

/**
 * `goOnline(db)` — reconnect the client to the RTDB backend.
 *
 * Reconnects the logical client. Executed disconnect operations are not
 * resurrected; reads and writes remain synchronous in the local sandbox.
 */
export function goOnline(db: Database): void {
  targetOf(db as unknown as object).connection.goOnline();
}

/**
 * `forceLongPolling()` — force the long-polling transport for all
 * subsequent `getDatabase` connections.
 *
 * No-op: transport selection is meaningless to the in-process/worker
 * sandbox, which never opens a real socket. Accepted so init code that
 * calls it unconditionally compiles + runs.
 */
export function forceLongPolling(): void {
  // Accepted no-op — see docstring.
}

/**
 * `forceWebSockets()` — force the WebSocket transport for all
 * subsequent `getDatabase` connections.
 *
 * No-op: transport selection is not applicable to the in-process/worker
 * sandbox (see {@link forceLongPolling}).
 */
export function forceWebSockets(): void {
  // Accepted no-op — see docstring.
}

/**
 * `enableLogging(logger?, persistent?)` — toggle RTDB SDK logging.
 *
 * Accepted no-op: the sandbox has no modular-SDK-style logger to wire a
 * level/sink into (it uses host-level `console` logging directly, gated
 * by `pyric dev`'s own flags — matching `pyric/firestore`'s
 * `setLogLevel`). Accepted so init code that calls it compiles + runs.
 */
export function enableLogging(
  logger?: boolean | ((message: string) => void),
  persistent?: boolean,
): void {
  void logger;
  void persistent;
}

/**
 * `refFromURL(db, url)` — build a {@link DatabaseReference} from an
 * absolute database URL (`https://<namespace>.firebaseio.com/path`).
 *
 * Real alias with real behavior: parses the path out of the URL and
 * delegates to {@link ref}, so the returned ref resolves + reads exactly
 * like `ref(db, path)`. The sandbox is single-database and has no host /
 * namespace, so the URL's HOST is not validated against the handle (the
 * real SDK throws if the host doesn't match the db's namespace); only
 * the path component is honored.
 */
export function refFromURL(db: Database, url: string): DatabaseReference {
  // Strip the scheme + host, keep the path. `new URL` handles the
  // `https://<ns>.firebaseio.com/a/b` and `.firebasedatabase.app`
  // hosts alike; the query string / hash (if any) is dropped —
  // RTDB paths carry neither.
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    throw new Error(
      `pyric/database: refFromURL received a value that is not an absolute URL: ${url}`,
    );
  }
  return ref(db, path);
}
