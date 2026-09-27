import { FirestoreSet } from './firestore-set.js';
import { MapDiff } from './mapdiff.js';
import { RulesValue } from './wrappers/base.js';

/** A Rules map is a plain key/value record, never a boxed scalar/wrapper. */
export function isRulesMap(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The Rules type name of a value, as production's error messages spell it. */
export function describeRulesType(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof RulesValue) return value.typeName;
  if (value instanceof FirestoreSet) return 'set';
  if (value instanceof MapDiff) return 'map_diff';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'boolean') return 'bool';
  if (Array.isArray(value)) return 'list';
  if (isRulesMap(value)) return 'map';
  return typeof value;
}
