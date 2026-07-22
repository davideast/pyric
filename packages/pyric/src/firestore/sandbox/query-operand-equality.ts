import { registeredQueryValue } from './query-value-registry.js';
import { firestoreValuesEqual } from './value-equality.js';

export type CapturedQueryOperand =
  | { readonly kind: 'canonical'; readonly value: unknown }
  | { readonly kind: 'identity'; readonly value: unknown };

function canonicalize(
  value: unknown,
  ancestors: Set<object>,
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Object.is(value, -0) ? 0 : value;
  if (typeof value === 'undefined' || typeof value === 'bigint') return value;
  if (typeof value === 'function') throw new TypeError('Functions are identity-only query operands.');
  if (typeof value !== 'object') return String(value);

  const registered = registeredQueryValue(value);
  if (registered !== undefined) {
    return { type: 'registered-firestore-value', value: registered };
  }
  if (value instanceof Date) {
    return { type: 'date', millis: value.getTime() };
  }
  if (value instanceof Uint8Array) {
    return { type: 'bytes', values: Array.from(value) };
  }
  if (ancestors.has(value)) throw new TypeError('Cyclic query operands are not Firestore values.');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return {
        type: 'array',
        values: value.map((entry) => canonicalize(entry, ancestors)),
      };
    }

    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonicalize((value as Record<string, unknown>)[key], ancestors)]);
    return { type: 'map', entries };
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Capture the Firestore value representation when a query is constructed.
 * This is the same lifecycle point at which Firebase parses query values.
 * Equality later compares only this trusted snapshot and never re-observes
 * the caller's object, getter, Proxy, or function.
 */
export function captureQueryOperand(value: unknown): CapturedQueryOperand {
  try {
    return Object.freeze({
      kind: 'canonical' as const,
      value: canonicalize(value, new Set()),
    });
  } catch {
    if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
      return Object.freeze({ kind: 'identity' as const, value });
    }
    return Object.freeze({ kind: 'canonical' as const, value });
  }
}

export function capturedQueryOperandsEqual(
  left: CapturedQueryOperand,
  right: CapturedQueryOperand,
): boolean {
  if (left.kind === 'identity' || right.kind === 'identity') {
    return left.kind === 'identity'
      && right.kind === 'identity'
      && left.value === right.value;
  }
  return firestoreValuesEqual(left.value, right.value);
}
