import { RulesFloat } from './wrappers/float.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Rehydrate Firestore numeric types carried by JSON-shaped Rules fixtures. */
export function reviveTestValue(value: unknown): unknown {
  // The hosted Rules Test API preserves JSON numbers with a fractional part
  // as Firestore doubles. Plain JS has one Number type, so recover that
  // unambiguous wire distinction before the evaluator sees the payload.
  if (typeof value === 'number' && !Number.isInteger(value)) {
    return new RulesFloat(value);
  }
  if (Array.isArray(value)) return value.map(reviveTestValue);
  if (!isPlainObject(value)) return value;
  if (value.__type === 'float' && typeof value.value === 'number') {
    return new RulesFloat(value.value);
  }
  const revived: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    revived[key] = reviveTestValue(child);
  }
  return revived;
}
