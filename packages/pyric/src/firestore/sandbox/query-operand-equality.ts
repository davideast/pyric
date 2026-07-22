import {
  registeredQueryValue,
  registeredQueryExecutionValue,
  registeredQueryValueOwner,
  registerQueryValue,
} from './query-value-registry.js';
import { firestoreValuesEqual } from './value-equality.js';
import { FirestoreCompatError } from './firestore-compat-error.js';

export type CapturedQueryOperand = {
  readonly kind: 'canonical';
  readonly value: unknown;
  readonly executionValue: unknown;
};

interface CanonicalQueryValue {
  comparison: unknown;
  execution: unknown;
}

function invalidOperand(message: string): FirestoreCompatError {
  return new FirestoreCompatError({ code: 'invalid-argument', message });
}

function canonicalize(
  value: unknown,
  ancestors: Set<object>,
  owner?: object,
): CanonicalQueryValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return { comparison: value, execution: value };
  }
  if (typeof value === 'number') return { comparison: value, execution: value };
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
    return {
      comparison: { type: 'registered-firestore-value', value: registered },
      execution: registeredQueryExecutionValue(value),
    };
  }
  if (value instanceof Date) {
    const millis = value.getTime();
    if (!Number.isFinite(millis)) throw invalidOperand('Invalid Date query value.');
    const seconds = Math.floor(millis / 1_000);
    const timestamp = Object.freeze({
      seconds,
      nanoseconds: Math.floor((millis - seconds * 1_000) * 1_000_000),
    });
    const timestampSnapshot = { type: 'timestamp', ...timestamp };
    registerQueryValue(
      timestamp,
      timestampSnapshot,
      () => Object.freeze({ ...timestamp }),
    );
    return {
      comparison: {
        type: 'registered-firestore-value',
        value: timestampSnapshot,
      },
      execution: timestamp,
    };
  }
  if (value instanceof Uint8Array) {
    const copy = value.slice();
    return {
      comparison: { type: 'bytes', values: Array.from(copy) },
      execution: copy,
    };
  }
  if (ancestors.has(value)) throw invalidOperand('Cyclic query operands are not Firestore values.');

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    throw invalidOperand('Firestore query maps must be plain objects.');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries = value.map((entry) => canonicalize(entry, ancestors, owner));
      return {
        comparison: {
          type: 'array',
          values: entries.map((entry) => entry.comparison),
        },
        execution: entries.map((entry) => entry.execution),
      };
    }

    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => ({
        key,
        captured: canonicalize(
          (value as Record<string, unknown>)[key],
          ancestors,
          owner,
        ),
      }));
    return {
      comparison: {
        type: 'map',
        entries: entries.map(({ key, captured }) => [key, captured.comparison]),
      },
      execution: Object.fromEntries(
        entries.map(({ key, captured }) => [key, captured.execution]),
      ),
    };
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
    const captured = canonicalize(value, new Set(), owner);
    return Object.freeze({
      kind: 'canonical' as const,
      value: captured.comparison,
      executionValue: captured.execution,
    });
  } catch (error) {
    if (error instanceof FirestoreCompatError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw invalidOperand(`Invalid Firestore query value: ${message}`);
  }
}

export function capturedQueryOperandsEqual(
  left: CapturedQueryOperand,
  right: CapturedQueryOperand,
): boolean {
  return firestoreValuesEqual(left.value, right.value);
}
