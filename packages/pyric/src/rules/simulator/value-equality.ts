import { FirestoreSet } from './firestore-set.js';
import { RulesValue } from './wrappers/base.js';

/**
 * Firestore Rules value equality.
 *
 * Rules wrappers and FirestoreSet own equality; lists and maps compare
 * structurally, with map key order ignored.
 */
export function rulesValuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof RulesValue) return a.equals(b);
  if (b instanceof RulesValue) return b.equals(a);
  if (a instanceof FirestoreSet || b instanceof FirestoreSet) {
    return a instanceof FirestoreSet && a.equals(b);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((value, index) => rulesValuesEqual(value, b[index]));
  }
  if (!isRulesMapValue(a) || !isRulesMapValue(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => key in b && rulesValuesEqual(a[key], b[key]));
}

function isRulesMapValue(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
