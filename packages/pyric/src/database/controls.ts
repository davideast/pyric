import { targetOf } from './routing.js';
import type { Database, EmulatorMockTokenOptions } from './types.js';

// ─── Emulator (no-op on sandbox) ─────────────────────────────────────

/**
 * `connectDatabaseEmulator(db, host, port)` is an accepted no-op because the
 * selected backend already is the local sandbox.
 */
export function connectDatabaseEmulator(
  _db: Database,
  _host: string,
  _port: number,
  _options?: { mockUserToken?: string | EmulatorMockTokenOptions },
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
 * by `pyric sandbox`'s own flags — matching `pyric/firestore`'s
 * `setLogLevel`). Accepted so init code that calls it compiles + runs.
 */
export function enableLogging(
  logger?: boolean | ((message: string) => void),
  persistent?: boolean,
): void {
  void logger;
  void persistent;
}
