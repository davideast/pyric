import {
  registeredQueryValue,
  registeredQueryValueOwner,
} from './query-value-registry.js';
import { firestoreValuesEqual } from './value-equality.js';
import { FirestoreCompatError } from './firestore-compat-error.js';

export type CapturedQueryOperand = { readonly kind: 'canonical'; readonly value: unknown };

function invalidOperand(message: string): FirestoreCompatError {
  return new FirestoreCompatError({ code: 'invalid-argument', message });
}

function canonicalize(
  value: unknown,
  ancestors: Set<object>,
  owner?: object,
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'undefined' || typeof value === 'bigint'
    || typeof value === 'function' || typeof value === 'symbol') {
    throw invalidOperand(`Unsupported Firestore query value: ${typeof value}.`);
  }
  if (typeof value !== 'object') throw invalidOperand('Unsupported Firestore query value.');

  const registered = registeredQueryValue(value);
  if (registered !== undefined) {
    const registeredOwner = registeredQueryValueOwner(value);
    if (registeredOwner !== undefined && owner !== undefined && registeredOwner !== owner) {
      throw invalidOperand('Document reference belongs to a different Firestore database.');
    }
    return { type: 'registered-firestore-value', value: registered };
  }
  if (value instanceof Date) {
    const millis = value.getTime();
    if (!Number.isFinite(millis)) throw invalidOperand('Invalid Date query value.');
    const seconds = Math.floor(millis / 1_000);
    return {
      type: 'registered-firestore-value',
      value: {
        type: 'timestamp',
        seconds,
        nanoseconds: Math.floor((millis - seconds * 1_000) * 1_000_000),
      },
    };
  }
  if (value instanceof Uint8Array) {
    return { type: 'bytes', values: Array.from(value) };
  }
  if (ancestors.has(value)) throw invalidOperand('Cyclic query operands are not Firestore values.');

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    throw invalidOperand('Firestore query maps must be plain objects.');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return {
        type: 'array',
        values: value.map((entry) => canonicalize(entry, ancestors, owner)),
      };
    }

    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonicalize(
        (value as Record<string, unknown>)[key],
        ancestors,
        owner,
      )]);
    return { type: 'map', entries };
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Capture the Firestore value representation when a query is constructed.
 * This is the same lifecycle point at which Firebase parses query values.
 * Equality later compares only this trusted snapshot and never re-observes
 * the caller's supported Firestore value or its getters.
 */
export function captureQueryOperand(value: unknown, owner?: object): CapturedQueryOperand {
  try {
    return Object.freeze({
      kind: 'canonical' as const,
      value: canonicalize(value, new Set(), owner),
    });
  } catch (error) {
    if (error instanceof FirestoreCompatError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw invalidOperand(`Invalid Firestore query value: ${message}`);
  }
}

/** Validate the owning database for a direct DocumentReference operand. */
export function assertQueryOperandOwner(value: unknown, owner: object): void {
  if (typeof value !== 'object' || value === null) return;
  const registeredOwner = registeredQueryValueOwner(value);
  if (registeredOwner !== undefined && registeredOwner !== owner) {
    throw invalidOperand('Document reference belongs to a different Firestore database.');
  }
}

export function capturedQueryOperandsEqual(
  left: CapturedQueryOperand,
  right: CapturedQueryOperand,
): boolean {
  return firestoreValuesEqual(left.value, right.value);
}
