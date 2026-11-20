/**
 * `pyric/firestore` - `connectFirestoreEmulator` lifecycle and option parity.
 *
 * Mirrors `firebase/firestore` `connectFirestoreEmulator(db, host, port, options)`:
 * validates the Firestore handle and its pre-start lifecycle (`failed-precondition`
 * once the client has started or been terminated) and validates object-form
 * `mockUserToken` claims (`sub` or `user_id` required) while keeping the sandbox
 * backend local.
 */
import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import { clientStateFor } from './client-state.js';
import { targetOf } from './state.js';
import type { EmulatorMockTokenOptions, Firestore } from './types.js';

export interface ConnectFirestoreEmulatorOptions {
  mockUserToken?: EmulatorMockTokenOptions | string;
  ssl?: boolean;
}

const ALREADY_STARTED_MESSAGE =
  'Firestore has already been started and its settings can no longer be changed. ' +
  'You can only modify settings before calling any other methods on a Firestore object.';

function validateMockUserTokenOption(options: ConnectFirestoreEmulatorOptions | undefined): void {
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
  db: Firestore,
  host: string,
  port: number,
  options?: ConnectFirestoreEmulatorOptions,
): void {
  const target = targetOf(db);
  if (target.assertUsable) {
    target.assertUsable();
  }
  if (clientStateFor(target).isStarted()) {
    throw new FirebaseError('failed-precondition', ALREADY_STARTED_MESSAGE);
  }
  if (typeof host !== 'string' || typeof port !== 'number') {
    throw new FirebaseError(
      'invalid-argument',
      'connectFirestoreEmulator() requires a string host and numeric port.',
    );
  }
  validateMockUserTokenOption(options);
}
