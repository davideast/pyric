import {
  registeredQueryValue,
  registeredQueryExecutionValue,
  registeredQueryValueOwner,
  registerQueryValue,
} from './query-value-registry.js';
import { firestoreValuesEqual } from './value-equality.js';
import { FirestoreCompatError } from './firestore-compat-error.js';
import { activityValue } from './activity-query-value.js';
import { registerActivityValue } from './activity-value-registry.js';
import { Timestamp } from '../timestamp.js';

export type CapturedQueryOperand = {
  readonly kind: 'canonical';
  readonly value: unknown;
  readonly executionValue: unknown;
};

interface CanonicalQueryValue {
  comparison: unknown;
  execution: unknown;
}

interface TimestampIdentity {
  type: 'timestamp';
  seconds: number;
  nanoseconds: number;
}

function isTimestampIdentity(value: unknown): value is TimestampIdentity {
  const isRecord = value !== null && typeof value === 'object';
  if (isRecord) {
    const hasTimestampMarker = 'type' in value && value.type === 'timestamp';
    const hasSeconds = 'seconds' in value && typeof value.seconds === 'number';
    const hasNanoseconds = 'nanoseconds' in value && typeof value.nanoseconds === 'number';
    return hasTimestampMarker && hasSeconds && hasNanoseconds;
  }
  return false;
}

function invalidOperand(message: string): FirestoreCompatError {
  return new FirestoreCompatError({ code: 'invalid-argument', message });
}

function canonicalize(
  value: unknown,
  ancestors: Set<object>,
  owner?: object,
  allowNestedArrays = false,
  parentIsArray = false,
): CanonicalQueryValue {
  const isSimpleScalar = value === null || typeof value === 'string' || typeof value === 'boolean';
  if (isSimpleScalar) {
    return { comparison: value, execution: value };
  }
  const isNumber = typeof value === 'number';
  if (isNumber) return { comparison: value, execution: value };
  const isUnsupportedPrimitive = typeof value === 'undefined' || typeof value === 'bigint'
    || typeof value === 'function' || typeof value === 'symbol';
  if (isUnsupportedPrimitive) {
    throw invalidOperand(`Unsupported Firestore query value: ${typeof value}.`);
  }
  const isNotObject = typeof value !== 'object';
  if (isNotObject) throw invalidOperand('Unsupported Firestore query value.');

  const registered = registeredQueryValue(value);
  const isRegisteredValue = registered !== undefined;
  if (isRegisteredValue) {
    const registeredOwner = registeredQueryValueOwner(value);
    const hasForeignOwner = registeredOwner !== undefined && owner !== undefined && registeredOwner !== owner;
    if (hasForeignOwner) {
      throw invalidOperand('Document reference belongs to a different Firestore database.');
    }
    const isTimestamp = isTimestampIdentity(registered);
    if (isTimestamp) {
      const nanoseconds = Math.floor(registered.nanoseconds / 1_000) * 1_000;
      const timestamp = new Timestamp(registered.seconds, nanoseconds);
      return {
        comparison: {
          type: 'registered-firestore-value',
          value: Object.freeze({ type: 'timestamp', seconds: timestamp.seconds, nanoseconds }),
        },
        execution: timestamp,
      };
    }
    return {
      comparison: { type: 'registered-firestore-value', value: registered },
      execution: registeredQueryExecutionValue(value),
    };
  }
  const isDate = value instanceof Date;
  if (isDate) {
    const millis = value.getTime();
    const isInvalidDate = !Number.isFinite(millis);
    if (isInvalidDate) throw invalidOperand('Invalid Date query value.');
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
  const isByteArray = value instanceof Uint8Array;
  if (isByteArray) {
    const copy = value.slice();
    return {
      comparison: { type: 'bytes', values: Array.from(copy) },
      execution: copy,
    };
  }
  const isCyclicValue = ancestors.has(value);
  if (isCyclicValue) throw invalidOperand('Cyclic query operands are not Firestore values.');

  const prototype = Object.getPrototypeOf(value);
  const hasUnsupportedPrototype = prototype !== Object.prototype && prototype !== null && !Array.isArray(value);
  if (hasUnsupportedPrototype) {
    throw invalidOperand('Firestore query maps must be plain objects.');
  }

  ancestors.add(value);
  try {
    const isArray = Array.isArray(value);
    if (isArray) {
      const isDisallowedNestedArray = parentIsArray && !allowNestedArrays;
      if (isDisallowedNestedArray) {
        throw invalidOperand('Nested arrays are not supported.');
      }
      const entries = value.map((entry) => canonicalize(
        entry,
        ancestors,
        owner,
        allowNestedArrays,
        true,
      ));
      const execution = entries.map((entry) => entry.execution);
      registerActivityValue(execution, activityValue(value));
      return {
        comparison: {
          type: 'array',
          values: entries.map((entry) => entry.comparison),
        },
        execution,
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
          allowNestedArrays,
          false,
        ),
      }));
    const execution = Object.fromEntries(
      entries.map(({ key, captured }) => [key, captured.execution]),
    );
    registerActivityValue(execution, activityValue(value));
    return {
      comparison: {
        type: 'map',
        entries: entries.map(({ key, captured }) => [key, captured.comparison]),
      },
      execution,
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
export function captureQueryOperand(
  value: unknown,
  owner?: object,
  allowNestedArrays = false,
): CapturedQueryOperand {
  try {
    const captured = canonicalize(value, new Set(), owner, allowNestedArrays);
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
