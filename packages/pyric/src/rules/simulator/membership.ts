import { FirestoreSet } from './firestore-set.js';
import { describeRulesType, isRulesMap } from './rules-type.js';

/**
 * The `in` operator of the rules language, shared by the Firestore simulator
 * and the Storage evaluator.
 *
 * `x in list` and `x in set` test elements under the caller's value
 * equality, and `x in map` tests the map's own keys, never inherited object
 * members. A null right operand is `Null value error.`, any other value that
 * is not a list, set or map (string, int, float, bool, timestamp, path, map
 * diff) is `Function not found error: Name: [in].`, and a map key that is not
 * a string is an unsupported operation. Firestore and Storage report the same
 * verdict and text for every shape (corpus scenarios `prototype-chain-keys`
 * and `in-membership-and-proto-keys`).
 *
 * A failure is returned as a `MembershipFailure` carrying production's
 * message. Each evaluator turns it into its own error value, so `&&` and `||`
 * can absorb it.
 */
export class MembershipFailure {
  constructor(readonly message: string) {}
}

export function membership(
  element: unknown,
  collection: unknown,
  equals: (left: unknown, right: unknown) => boolean,
): boolean | MembershipFailure {
  if (collection === null || collection === undefined) return new MembershipFailure('Null value error.');
  if (Array.isArray(collection)) return collection.some((member) => equals(member, element));
  if (collection instanceof FirestoreSet) return collection.toArray().some((member) => equals(member, element));
  if (isRulesMap(collection)) {
    if (typeof element !== 'string') {
      return new MembershipFailure(
        `Unsupported operation error. Received: map.in(${describeRulesType(element)}). Expected: map.in(string).`,
      );
    }
    return Object.hasOwn(collection, element);
  }
  return new MembershipFailure('Function not found error: Name: [in].');
}
