import {
  boundedActivityIdentity,
  boundedActivityString,
  registeredActivityValue,
} from './activity-value-registry.js';

const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;

function objectId(value: object): number {
  let id = objectIds.get(value);
  if (id === undefined) {
    id = nextObjectId++;
    objectIds.set(value, id);
  }
  return id;
}

/**
 * Project a Firestore query operand without observing user code. Reflection,
 * `instanceof`, array checks, and property reads can all execute Proxy traps,
 * so arbitrary objects are deliberately opaque and use stable identity only.
 * This trades structural matching of freshly-created object operands for the
 * stronger warning-only guarantee: diagnostics can never change query behavior.
 */
export function activityValue(value: unknown): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return boundedActivityString(value);
  if (typeof value === 'undefined') return { type: 'undefined' };
  if (typeof value === 'bigint') {
    return boundedActivityIdentity('bigint', value.toString());
  }
  if (typeof value === 'number') {
    const normalized = Number.isNaN(value)
      ? 'NaN'
      : value === Infinity
        ? 'Infinity'
        : value === -Infinity
          ? '-Infinity'
          : Object.is(value, -0)
            ? '-0'
            : String(value);
    return boundedActivityIdentity('number', normalized);
  }
  if (typeof value !== 'object' && typeof value !== 'function') {
    return { type: typeof value, value: String(value) };
  }
  const registered = registeredActivityValue(value);
  if (registered !== undefined) return registered;
  // Array.isArray performs no user property access or Proxy trap. A revoked
  // Proxy throws, so treat it as opaque. Array contents cannot be inspected
  // safely, so arrays use object identity: diagnostics must not call distinct
  // array-valued queries "identical" merely because their shapes agree.
  try {
    if (Array.isArray(value)) return { type: 'array', id: objectId(value) };
  } catch {
    // Revoked Proxy — identity is the only side-effect-free signal available.
  }
  return { type: 'opaque-object', id: objectId(value) };
}
