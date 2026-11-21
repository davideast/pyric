/**
 * Numeric gRPC status code error construction and translation for app-backed
 * `pyric-admin/firestore` handles (`firebase-admin/firestore` parity, #1981).
 *
 * App-backed handles (`getFirestore()`, `getFirestore(app)`, `initializeFirestore(app)`,
 * and `admin.firestore(app?)`) expose numeric `GrpcStatus` codes (`5` NOT_FOUND,
 * `6` ALREADY_EXISTS, `3` INVALID_ARGUMENT, `9` FAILED_PRECONDITION, `10` ABORTED,
 * `7` PERMISSION_DENIED, etc.) matching `@google-cloud/firestore`.
 *
 * Internal sandbox-context handles (`getFirestore(ctx)` and `getAdminFirestore(sandbox)`)
 * preserve `SandboxError` string codes and `denialContext` for rules-simulation callers.
 */

import { GrpcStatus } from './admin-grpc-log.js';
import { isAppBackedRoot } from './admin-handle-registry.js';

export interface AdminFirestoreGrpcError extends Error {
  code: number;
  details: string;
}

const STRING_CODE_TO_GRPC_STATUS: Readonly<Record<string, number>> = Object.freeze({
  ok: GrpcStatus.OK as number,
  cancelled: GrpcStatus.CANCELLED as number,
  canceled: GrpcStatus.CANCELLED as number,
  unknown: GrpcStatus.UNKNOWN as number,
  'invalid-argument': GrpcStatus.INVALID_ARGUMENT as number,
  'deadline-exceeded': GrpcStatus.DEADLINE_EXCEEDED as number,
  'not-found': GrpcStatus.NOT_FOUND as number,
  'already-exists': GrpcStatus.ALREADY_EXISTS as number,
  'permission-denied': GrpcStatus.PERMISSION_DENIED as number,
  'resource-exhausted': GrpcStatus.RESOURCE_EXHAUSTED as number,
  'failed-precondition': GrpcStatus.FAILED_PRECONDITION as number,
  aborted: GrpcStatus.ABORTED as number,
  'out-of-range': GrpcStatus.OUT_OF_RANGE as number,
  unimplemented: GrpcStatus.UNIMPLEMENTED as number,
  internal: GrpcStatus.INTERNAL as number,
  unavailable: GrpcStatus.UNAVAILABLE as number,
  'data-loss': GrpcStatus.DATA_LOSS as number,
  unauthenticated: GrpcStatus.UNAUTHENTICATED as number,
});

function mapStringCodeToGrpcStatus(code: string): number | undefined {
  if (Object.hasOwn(STRING_CODE_TO_GRPC_STATUS, code)) {
    return STRING_CODE_TO_GRPC_STATUS[code];
  }
  return undefined;
}

export function createAdminGrpcError(
  code: number,
  message: string,
  sourceStack?: string,
): AdminFirestoreGrpcError {
  const err = new Error(message) as AdminFirestoreGrpcError;
  err.code = code;
  err.details = message;
  if (typeof sourceStack === 'string' && sourceStack.length > 0) {
    err.stack = sourceStack;
  }
  return err;
}

function translateAdminError(err: unknown, appBacked: boolean): unknown {
  if (!appBacked) {
    return err;
  }
  if (err === null || typeof err !== 'object') {
    return err;
  }
  const candidate = err as { code?: unknown; message?: unknown; stack?: unknown };
  if (typeof candidate.code === 'number') {
    return err;
  }
  if (typeof candidate.code !== 'string') {
    return err;
  }
  const mappedCode = mapStringCodeToGrpcStatus(candidate.code);
  if (mappedCode === undefined) {
    return err;
  }
  let message = String(candidate.code);
  if (typeof candidate.message === 'string') {
    message = candidate.message;
  }
  let sourceStack: string | undefined;
  if (typeof candidate.stack === 'string') {
    sourceStack = candidate.stack;
  }
  return createAdminGrpcError(mappedCode, message, sourceStack);
}

export function translateErrorForRootDb(err: unknown, rootDb: object): unknown {
  return translateAdminError(err, isAppBackedRoot(rootDb));
}

export function runWithAdminErrorsSync<T>(appBacked: boolean, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw translateAdminError(err, appBacked);
  }
}

export async function runWithAdminErrorsAsync<T>(
  appBacked: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw translateAdminError(err, appBacked);
  }
}
