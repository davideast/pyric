import { FirebaseError } from 'pyric/app';
import type { SentinelMarker } from '../protocol.js';
import {
  FieldValue,
  createArrayRemoveSentinel,
  createArrayUnionSentinel,
  createDeleteFieldSentinel,
  createIncrementSentinel,
  createMaximumSentinel,
  createMinimumSentinel,
  createServerTimestampSentinel,
} from 'pyric/firestore/internal/value-codec';

export function serverTimestamp(): FieldValue & SentinelMarker {
  return createServerTimestampSentinel() as unknown as FieldValue & SentinelMarker;
}

export function increment(n: number): FieldValue & SentinelMarker {
  return createIncrementSentinel(n) as unknown as FieldValue & SentinelMarker;
}

export function maximum(n: number): FieldValue & SentinelMarker {
  return createMaximumSentinel(n) as unknown as FieldValue & SentinelMarker;
}

export function minimum(n: number): FieldValue & SentinelMarker {
  return createMinimumSentinel(n) as unknown as FieldValue & SentinelMarker;
}

export function arrayUnion(...values: unknown[]): FieldValue & SentinelMarker {
  return createArrayUnionSentinel(values) as unknown as FieldValue & SentinelMarker;
}

export function arrayRemove(...values: unknown[]): FieldValue & SentinelMarker {
  return createArrayRemoveSentinel(values) as unknown as FieldValue & SentinelMarker;
}

export function deleteField(): FieldValue & SentinelMarker {
  return createDeleteFieldSentinel() as unknown as FieldValue & SentinelMarker;
}

function assertWorkerWriteValue(
  methodName: string,
  documentPath: string,
  value: unknown,
  rejectUndefined: boolean,
  seen: WeakSet<object>,
): void {
  if (rejectUndefined && value === undefined) {
    throw new FirebaseError(
      'invalid-argument',
      `Function ${methodName}() called with invalid data. Unsupported field value: undefined (found in document ${documentPath})`,
    );
  }
  if (typeof value === 'bigint') {
    throw new FirebaseError(
      'invalid-argument',
      `Function ${methodName}() called with invalid data. Unsupported field value: bigint (found in document ${documentPath})`,
    );
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (entry !== null && typeof entry === 'object' && '__sentinel' in entry) {
        const kind = (entry as { __sentinel?: unknown }).__sentinel;
        if (kind === 'maximum' || kind === 'minimum') {
          throw new FirebaseError(
            'invalid-argument',
            `Function ${methodName}() called with invalid data. ${kind}() is not currently supported inside arrays (found in document ${documentPath})`,
          );
        }
      }
      assertWorkerWriteValue(methodName, documentPath, entry, rejectUndefined, seen);
    }
    return;
  }
  if ('__sentinel' in value) {
    const sentinel = value as { __sentinel?: unknown; n?: unknown; values?: unknown };
    if (sentinel.__sentinel === 'serverTimestamp' || sentinel.__sentinel === 'deleteField') {
      return;
    }
    if (sentinel.__sentinel === 'increment') {
      assertWorkerWriteValue(methodName, documentPath, sentinel.n, rejectUndefined, seen);
      return;
    }
    if (sentinel.__sentinel === 'maximum' || sentinel.__sentinel === 'minimum') {
      assertWorkerWriteValue(methodName, documentPath, sentinel.n, true, seen);
      if (typeof sentinel.n !== 'number') {
        throw new FirebaseError(
          'invalid-argument',
          `Function ${methodName}() called with invalid data. ${sentinel.__sentinel}() requires a numeric argument (found in document ${documentPath})`,
        );
      }
      return;
    }
    if (
      (sentinel.__sentinel === 'arrayUnion' || sentinel.__sentinel === 'arrayRemove')
      && Array.isArray(sentinel.values)
    ) {
      for (const entry of sentinel.values) {
        if (entry !== null && typeof entry === 'object' && '__sentinel' in entry) {
          const kind = (entry as { __sentinel?: unknown }).__sentinel;
          if (kind === 'maximum' || kind === 'minimum') {
            throw new FirebaseError(
              'invalid-argument',
              `Function ${sentinel.__sentinel}() called with invalid data. ${kind}() can only be used with update() and set() (found in document ${documentPath})`,
            );
          }
        }
        assertWorkerWriteValue(methodName, documentPath, entry, rejectUndefined, seen);
      }
      return;
    }
  }
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    for (const entry of Object.values(value)) {
      assertWorkerWriteValue(methodName, documentPath, entry, rejectUndefined, seen);
    }
  }
}

export function assertNoSentinelInWorkerQueryOperand(
  methodName: string,
  value: unknown,
  seen = new WeakSet<object>(),
): void {
  if (value === null || typeof value !== 'object') return;
  if (value instanceof FieldValue) {
    const label = value._methodName || 'FieldValue';
    throw new FirebaseError(
      'invalid-argument',
      `Function ${methodName}() called with invalid data. ${label}() can only be used with update() and set()`,
    );
  }
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertNoSentinelInWorkerQueryOperand(methodName, entry, seen);
    }
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    for (const entry of Object.values(value)) {
      assertNoSentinelInWorkerQueryOperand(methodName, entry, seen);
    }
  }
}

export function assertNoUndefinedInWorkerSentinels(
  methodName: string,
  documentPath: string,
  value: unknown,
  seen = new WeakSet<object>(),
): void {
  assertWorkerWriteValue(methodName, documentPath, value, true, seen);
}

export function assertNoBigIntInWorkerWriteData(
  methodName: string,
  documentPath: string,
  value: unknown,
  seen = new WeakSet<object>(),
): void {
  assertWorkerWriteValue(methodName, documentPath, value, false, seen);
}
