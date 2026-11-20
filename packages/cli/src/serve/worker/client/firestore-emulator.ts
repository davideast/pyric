/**
 * `connectFirestoreEmulator` lifecycle and option validation for the
 * SharedWorker and Node-hosted WebSocket Firestore client planes (`FS-120`, `FS-121`).
 */
import { FirebaseError } from 'pyric/app';
import type { ConnectFirestoreEmulatorOptions } from 'pyric/firestore';
import {
  assertWorkerClientDb,
  assertWorkerFirestoreActive,
  isWorkerDbStartedAndRunning,
} from './firestore-lifecycle.js';
import type { ClientDb } from './handles.js';

const ALREADY_STARTED_MESSAGE =
  'Firestore has already been started and its settings can no longer be changed. ' +
  'You can only modify settings before calling any other methods on a Firestore object.';

function validateWorkerMockUserToken(options: ConnectFirestoreEmulatorOptions | undefined): void {
  if (options === undefined || options === null || typeof options !== 'object') {
    return;
  }
  if (!('mockUserToken' in options)) {
    return;
  }
  const token = options.mockUserToken;
  if (token === undefined || typeof token === 'string') {
    return;
  }
  if (token === null || typeof token !== 'object') {
    throw new Error("mockUserToken must contain 'sub' or 'user_id' field!");
  }
  const record = token as Record<string, unknown>;
  const hasSub = typeof record.sub === 'string' && record.sub.length > 0;
  const hasUserId = typeof record.user_id === 'string' && record.user_id.length > 0;
  if (!hasSub && !hasUserId) {
    throw new Error("mockUserToken must contain 'sub' or 'user_id' field!");
  }
}

export function connectFirestoreEmulator(
  db: ClientDb,
  host: string,
  port: number,
  options?: ConnectFirestoreEmulatorOptions,
): void {
  assertWorkerClientDb(db, 'connectFirestoreEmulator');
  assertWorkerFirestoreActive(db);
  if (isWorkerDbStartedAndRunning(db)) {
    throw new FirebaseError('failed-precondition', ALREADY_STARTED_MESSAGE);
  }
  if (typeof host !== 'string' || typeof port !== 'number') {
    throw new FirebaseError(
      'invalid-argument',
      'connectFirestoreEmulator() requires a string host and numeric port.',
    );
  }
  validateWorkerMockUserToken(options);
}
