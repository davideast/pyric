import { evaluateEmulatorConnect } from './emulator.js';
import { emitClientDatabaseLog, enableLogging } from './logging.js';
import { markTargetStarted, targetOf } from './routing.js';
import type { Database, EmulatorMockTokenOptions } from './types.js';

export { enableLogging };

/**
 * `connectDatabaseEmulator(db, host, port, options?)` configures the database
 * handle's HTTP emulator URL origin and optional `mockUserToken` rule identity
 * before the instance starts, while keeping data operations on the local sandbox.
 */
export function connectDatabaseEmulator(
  db: Database,
  host: string,
  port: number,
  options?: { mockUserToken?: string | EmulatorMockTokenOptions },
): void {
  const target = targetOf(db as unknown as object, 'useEmulator');
  let projectId: string | undefined;
  const appCandidate = (db as { app?: { options?: { projectId?: string } } }).app;
  if (appCandidate !== undefined) {
    try {
      projectId = appCandidate.options?.projectId;
    } catch {
      projectId = undefined;
    }
  }
  const next = evaluateEmulatorConnect(
    target.started === true,
    target.emulatorConfig,
    host,
    port,
    options,
    projectId,
  );
  target.emulatorConfig = next;
  target.instanceUrl = next.normalizedOriginUrl;
  target.defaultRootUrl = next.normalizedOriginUrl;
  emitClientDatabaseLog('connectDatabaseEmulator', next.hostAndPort);
}

/**
 * `goOffline(db)` disconnects the client from the RTDB backend and drains this
 * client's one-shot onDisconnect queue while leaving the shared backend open to
 * other Database clients.
 */
export function goOffline(db: Database): void {
  const target = targetOf(db as unknown as object, 'goOffline');
  markTargetStarted(target);
  emitClientDatabaseLog('goOffline');
  target.connection.goOffline();
}

/**
 * `goOnline(db)` reconnects the logical client to the RTDB backend without
 * resurrecting already-drained disconnect operations.
 */
export function goOnline(db: Database): void {
  const target = targetOf(db as unknown as object, 'goOnline');
  markTargetStarted(target);
  emitClientDatabaseLog('goOnline');
  target.connection.goOnline();
}

/**
 * `forceLongPolling()` is an accepted no-op on the in-process/worker sandbox,
 * which never opens a real socket.
 */
export function forceLongPolling(): void {
  // Accepted no-op.
}

/**
 * `forceWebSockets()` is an accepted no-op on the in-process/worker sandbox
 * (see {@link forceLongPolling}).
 */
export function forceWebSockets(): void {
  // Accepted no-op.
}
