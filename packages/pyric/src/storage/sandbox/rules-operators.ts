import { RulesFloat } from '../../rules/simulator/wrappers/float.js';
import { RuleError, isRulesMap, numericValue as numVal } from './rules-values.js';

/**
 * `value is <type>` check. Numbers use the RULES-B5 model: a `RulesFloat`
 * wrapper is a FLOAT, a bare number is an INT — so `1.0 is float` and
 * `!(1.0 is int)` type by literal form exactly as production does. A bare
 * NON-integral number (a fractional value that arrived from data rather than
 * a literal, e.g. a Firestore-lookup double) still reads as float. `number`
 * accepts either.
 */
export function typeMatches(v: unknown, typeName: string): boolean | RuleError {
  switch (typeName) {
    case 'string': return typeof v === 'string';
    case 'bool': return typeof v === 'boolean';
    case 'int': return typeof v === 'number' && Number.isInteger(v);
    case 'float': return v instanceof RulesFloat || (typeof v === 'number' && !Number.isInteger(v));
    case 'number': return v instanceof RulesFloat || typeof v === 'number';
    case 'list': return Array.isArray(v);
    case 'map': return isRulesMap(v);
    default:
      // timestamp/duration/path/latlng are modeled as plain millis/strings
      // here — a type test against them cannot answer honestly, so deny
      // with a reason rather than false-allow.
      return new RuleError(`'is ${typeName}' is not supported by the storage evaluator.`);
  }
}

/** True for a float (RulesFloat); ints are bare numbers. */
export function isFloatNum(v: unknown): boolean {
  return v instanceof RulesFloat;
}

export function cmp(a: unknown, b: unknown): number {
  const an = numVal(a);
  const bn = numVal(b);
  // CEL compares int and float by numeric value (`1 < 1.5` is well-typed).
  if (an !== undefined && bn !== undefined) return an - bn;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return Number.NaN; // mismatched types → NaN → all comparisons return false
}

/** Arithmetic over ints and floats: unwraps, computes, and RE-TAGS the result
 *  as a float when either operand was one (int op float promotes to float). */
export function numOp(a: unknown, b: unknown, fn: (x: number, y: number) => number): unknown {
  const an = numVal(a);
  const bn = numVal(b);
  if (an === undefined || bn === undefined) return undefined;
  const result = fn(an, bn);
  return isFloatNum(a) || isFloatNum(b) ? new RulesFloat(result) : result;
}
