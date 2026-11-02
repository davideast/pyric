import { FirestoreSet } from './firestore-set.js';
import { isRulesMap } from './rules-type.js';
import { RulesValue } from './wrappers/base.js';
import { rulesFloatValue, rulesInt } from './rules-int.js';

/**
 * Rules value equality, shared by the Firestore simulator and the Storage
 * evaluator. Production compares numbers three ways, depending on where they
 * sit:
 *
 * - `rulesValuesEqual` is the `==` operator. Two numbers compare by value,
 *   so `1 == 1.0` and `0 == -0.0` hold and NaN equals nothing. Two Lists or
 *   two Maps are equal when each element or value is identical: of the same
 *   numeric type and value, with `0.0` distinct from `-0.0` and NaN
 *   identical to nothing, so `[1] == [1.0]` and `[0.0] == [-0.0]` are false.
 * - `listElementsEqual` is List membership: `in` over a List, a List
 *   receiver's `hasAny()`, `hasAll()` and `hasOnly()`, and `removeAll()`. Two
 *   numbers match when they have the same numeric type and value, so
 *   `1.0 in [1]` is false while `-0.0 in [0.0]` is true; a List or Map
 *   element compares as `==` compares it.
 * - `setElementsEqual` is how a Set and a map diff compare values: numbers
 *   by value at every depth, with NaN matching NaN, so `[1, 1.0].toSet()`,
 *   `[[1], [1.0]].toSet()` and `[NaN, NaN].toSet()` each have one element
 *   and `{'a': 1}.diff({'a': 1.0})` changes nothing.
 *
 * An int is a bigint or a bare integral number (`rules-int.ts`), and two
 * ints compare exactly, above 2^53 too. A float is a `RulesFloat` or a bare
 * number with a fraction. Timestamp, Duration, Bytes and other wrappers own
 * their equality; Map key order never matters. Corpus scenarios
 * `cross-type-operator-overloads`, `list-methods-concat-removeall-toset`,
 * `set-algebra-difference-union-intersection` and
 * `required-fields-and-mapdiff` (Firestore) and `list-map-literals-and-slice`,
 * `upload-primitives-boundaries` and `stdlib-sets-and-mapdiff` (Storage)
 * record production's verdicts, which are the same in both services.
 */
export function rulesValuesEqual(a: unknown, b: unknown): boolean {
  return valuesEqual(a, b, sameValue, identical);
}

/** List membership: numbers match by numeric type and value. See `rulesValuesEqual`. */
export function listElementsEqual(a: unknown, b: unknown): boolean {
  return valuesEqual(a, b, (l, r) => l.float === r.float && sameValue(l, r), identical);
}

/** Set and map diff comparison: numbers by value at every depth, NaN matching NaN. See `rulesValuesEqual`. */
export function setElementsEqual(a: unknown, b: unknown): boolean {
  return valuesEqual(
    a,
    b,
    (l, r) => sameValue(l, r) || (Number.isNaN(l.value) && Number.isNaN(r.value)),
    setElementsEqual,
  );
}

/** An element or value inside a List or Map that `==` compares. */
function identical(a: unknown, b: unknown): boolean {
  return valuesEqual(
    a,
    b,
    (l, r) => l.float === r.float && sameValue(l, r) && Object.is(l.value, r.value),
    identical,
  );
}

/**
 * A number as equality reads it. `int` holds an int's exact value, so two
 * ints compare every bit, above 2^53 too; `value` is the double that an int
 * and a float compare by.
 */
interface RulesNumber {
  value: number;
  int?: bigint;
  float: boolean;
}

function rulesNumber(value: unknown): RulesNumber | undefined {
  const int = rulesInt(value);
  if (int !== undefined) return { value: Number(int), int, float: false };
  const float = rulesFloatValue(value);
  return float === undefined ? undefined : { value: float, float: true };
}

/** Two numbers by value: two ints exactly, an int and a float as doubles. */
function sameValue(left: RulesNumber, right: RulesNumber): boolean {
  if (left.int !== undefined && right.int !== undefined) return left.int === right.int;
  return left.value === right.value;
}

function valuesEqual(
  a: unknown,
  b: unknown,
  numbersEqual: (left: RulesNumber, right: RulesNumber) => boolean,
  entriesEqual: (left: unknown, right: unknown) => boolean,
): boolean {
  const left = rulesNumber(a);
  const right = rulesNumber(b);
  if (left || right) return left !== undefined && right !== undefined && numbersEqual(left, right);
  if (a instanceof RulesValue) return a.equals(b);
  if (b instanceof RulesValue) return b.equals(a);
  if (a instanceof FirestoreSet || b instanceof FirestoreSet) {
    return a instanceof FirestoreSet && a.equals(b);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => entriesEqual(value, b[index]));
  }
  if (isRulesMap(a) || isRulesMap(b)) {
    if (!isRulesMap(a) || !isRulesMap(b)) return false;
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length) return false;
    return aKeys.every((key) => Object.hasOwn(b, key) && entriesEqual(a[key], b[key]));
  }
  return a === b;
}
