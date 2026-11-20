/**
 * `GrpcStatus` bidirectional enum object and `setLogFunction` hook for
 * `pyric-admin/firestore` matching `firebase-admin/firestore`.
 */

export const GrpcStatus: Readonly<Record<string, string | number>> = Object.freeze({
  0: 'OK',
  1: 'CANCELLED',
  2: 'UNKNOWN',
  3: 'INVALID_ARGUMENT',
  4: 'DEADLINE_EXCEEDED',
  5: 'NOT_FOUND',
  6: 'ALREADY_EXISTS',
  7: 'PERMISSION_DENIED',
  8: 'RESOURCE_EXHAUSTED',
  9: 'FAILED_PRECONDITION',
  10: 'ABORTED',
  11: 'OUT_OF_RANGE',
  12: 'UNIMPLEMENTED',
  13: 'INTERNAL',
  14: 'UNAVAILABLE',
  15: 'DATA_LOSS',
  16: 'UNAUTHENTICATED',
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16,
});

export type GrpcStatus = number;

let activeLogFunction: ((msg: string) => void) | null = null;

export function setLogFunction(logger?: ((msg: string) => void) | null): void {
  if (logger === null || logger === undefined) {
    activeLogFunction = null;
    return;
  }
  if (typeof logger !== 'function') {
    throw new Error('Value for argument "logger" is not a valid function.');
  }
  activeLogFunction = logger;
}

export function emitAdminFirestoreLog(message: string): void {
  if (activeLogFunction !== null) {
    activeLogFunction(message);
  }
}
