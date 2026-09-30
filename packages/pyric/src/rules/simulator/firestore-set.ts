import { functionNotFoundMessage } from './eval-error.js';
import { describeRulesType } from './rules-type.js';
import { setElementsEqual } from './value-equality.js';

/**
 * A rules Set. Elements compare under `setElementsEqual`: numbers by value at
 * every depth, with NaN matching NaN, so `[1, 1.0].toSet()` has one element.
 */
export class FirestoreSet {
  private items: unknown[];

  constructor(items: Iterable<unknown>) {
    this.items = [];
    for (const item of items) {
      if (!this.items.some((existing) => setElementsEqual(existing, item))) this.items.push(item);
    }
  }

  /** True if the set contains ONLY keys from the provided list/set (and no others). */
  hasOnly(keys: unknown[] | FirestoreSet): boolean {
    const arr = keys instanceof FirestoreSet ? keys.toArray() : keys;
    return this.items.every((item) => arr.some((key) => setElementsEqual(item, key)));
  }

  /** Value equality against another FirestoreSet (order-insensitive).
   *  Production supports `set == set` (e.g. `diff.addedKeys() ==
   *  [uid].toSet()`). */
  equals(other: unknown): boolean {
    if (!(other instanceof FirestoreSet)) return false;
    if (other.items.length !== this.items.length) return false;
    return this.items.every((item) => other.items.some((candidate) => setElementsEqual(item, candidate)));
  }

  /** True if the set contains ALL keys from the provided list/set. */
  hasAll(keys: unknown[] | FirestoreSet): boolean {
    const arr = keys instanceof FirestoreSet ? keys.toArray() : keys;
    for (const key of arr) {
      if (!this.items.some((item) => setElementsEqual(item, key))) return false;
    }
    return true;
  }

  /** True if the set contains ANY key from the provided list/set. */
  hasAny(keys: unknown[] | FirestoreSet): boolean {
    const arr = keys instanceof FirestoreSet ? keys.toArray() : keys;
    for (const key of arr) {
      if (this.items.some((item) => setElementsEqual(item, key))) return true;
    }
    return false;
  }

  /** True if the set contains `element`, as `element in set` tests it. */
  has(element: unknown): boolean {
    return this.items.some((item) => setElementsEqual(item, element));
  }

  /** Number of items in the set. */
  size(): number {
    return this.items.length;
  }

  /** Convert to array (for debugging). */
  toArray(): unknown[] {
    return [...this.items];
  }

  /** Items in this set but not in `other`. */
  difference(other: FirestoreSet): FirestoreSet {
    const otherItems = other.toArray();
    const result: unknown[] = [];
    for (const item of this.items) {
      if (!otherItems.some((candidate) => setElementsEqual(item, candidate))) result.push(item);
    }
    return new FirestoreSet(result);
  }

  /** Items in either set. */
  union(other: FirestoreSet): FirestoreSet {
    const otherArr = other.toArray();
    return new FirestoreSet([...this.items, ...otherArr]);
  }

  /** Items in both sets. */
  intersection(other: FirestoreSet): FirestoreSet {
    const otherItems = other.toArray();
    const result: unknown[] = [];
    for (const item of this.items) {
      if (otherItems.some((candidate) => setElementsEqual(item, candidate))) result.push(item);
    }
    return new FirestoreSet(result);
  }
}

/**
 * The methods of a Set receiver, shared by the Firestore simulator and the
 * Storage evaluator: `size()`, which takes no argument, `hasAll()`,
 * `hasAny()` and `hasOnly()`, which take one List or Set, and
 * `difference()`, `union()` and `intersection()`, which take one Set.
 * Another argument count is "Incorrect number of arguments" and another
 * argument type an unsupported operation, each naming the overloads. A Set has
 * no other method: `keys()`, `values()`, `get()`, `diff()` or a List
 * method on a Set is "Function not found error". Firestore and Storage report
 * the same text for every shape (corpus scenarios
 * `set-algebra-difference-union-intersection` and `stdlib-sets-and-mapdiff`).
 *
 * A failure is returned as a `SetMethodFailure` carrying production's
 * message. Each evaluator turns it into its own error value, so `&&` and
 * `||` can absorb it.
 */
export class SetMethodFailure {
  constructor(readonly message: string) {}
}

const SET_MEMBERSHIP = ['hasAll', 'hasAny', 'hasOnly'] as const;
const SET_ALGEBRA = ['difference', 'intersection', 'union'] as const;
type SetMembershipMethod = (typeof SET_MEMBERSHIP)[number];
type SetAlgebraMethod = (typeof SET_ALGEBRA)[number];

/** The Set algebra methods, which production reports as "Function not found error" on a List, string or Map. */
export const SET_ALGEBRA_NAMES: ReadonlySet<string> = new Set(SET_ALGEBRA);

function isMembership(method: string): method is SetMembershipMethod {
  return (SET_MEMBERSHIP as readonly string[]).includes(method);
}

/** `set.<method>(...args)`, or production's failure. */
export function setMethod(set: FirestoreSet, method: string, args: readonly unknown[]): unknown | SetMethodFailure {
  if (method === 'size') {
    if (args.length !== 0) {
      return new SetMethodFailure(`Incorrect number of arguments. Received: ${args.length}. Expected: set.size().`);
    }
    return set.size();
  }
  if (isMembership(method)) {
    const overloads = `set.${method}(set), set.${method}(list)`;
    if (args.length !== 1) {
      return new SetMethodFailure(`Incorrect number of arguments. Received: ${args.length}. Expected: ${overloads}.`);
    }
    const [other] = args;
    if (!Array.isArray(other) && !(other instanceof FirestoreSet)) {
      return new SetMethodFailure(
        `Unsupported operation error. Received: set.${method}(${describeRulesType(other)}). Expected: ${overloads}.`,
      );
    }
    return set[method](other);
  }
  if (SET_ALGEBRA_NAMES.has(method)) {
    const algebra = method as SetAlgebraMethod;
    if (args.length !== 1) {
      return new SetMethodFailure(
        `Incorrect number of arguments. Received: ${args.length}. Expected: set.${algebra}(set).`,
      );
    }
    const [other] = args;
    if (!(other instanceof FirestoreSet)) {
      return new SetMethodFailure(
        `Unsupported operation error. Received: set.${algebra}(${describeRulesType(other)}). Expected: set.${algebra}(set).`,
      );
    }
    return set[algebra](other);
  }
  return new SetMethodFailure(functionNotFoundMessage(method));
}
