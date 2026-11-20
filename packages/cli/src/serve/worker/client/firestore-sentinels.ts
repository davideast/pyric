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

export function assertNoUndefinedInWorkerSentinels(
  methodName: string,
  documentPath: string,
  value: unknown,
): void {
  if (value === undefined) {
    throw new FirebaseError(
      'invalid-argument',
      `Function ${methodName}() called with invalid data. Unsupported field value: undefined (found in document ${documentPath})`,
    );
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertNoUndefinedInWorkerSentinels(methodName, documentPath, entry);
    }
    return;
  }
  if (value !== null && typeof value === 'object' && '__sentinel' in value) {
    const sentinel = value as { values?: unknown };
    if (Array.isArray(sentinel.values)) {
      for (const entry of sentinel.values) {
        assertNoUndefinedInWorkerSentinels(methodName, documentPath, entry);
      }
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      for (const entry of Object.values(value)) {
        assertNoUndefinedInWorkerSentinels(methodName, documentPath, entry);
      }
    }
  }
}
