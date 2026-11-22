import { FirebaseError } from 'pyric/app';
import type { SentinelMarker } from '../protocol.js';
import {
  FieldValue,
  createArrayRemoveSentinel,
  createArrayUnionSentinel,
  createDeleteFieldSentinel,
  createIncrementSentinel,
  createServerTimestampSentinel,
} from 'pyric/firestore/internal/value-codec';

export function serverTimestamp(): FieldValue & SentinelMarker {
  return createServerTimestampSentinel() as unknown as FieldValue & SentinelMarker;
}

export function increment(n: number): FieldValue & SentinelMarker {
  return createIncrementSentinel(n) as unknown as FieldValue & SentinelMarker;
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
    if (
      (sentinel.__sentinel === 'arrayUnion' || sentinel.__sentinel === 'arrayRemove')
      && Array.isArray(sentinel.values)
    ) {
      for (const entry of sentinel.values) {
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
