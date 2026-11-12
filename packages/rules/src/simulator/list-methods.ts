import { ConversionFailure, applyConversion, conversionFor } from './conversions.js';
import { describeRulesType } from './rules-type.js';
import { listElementsEqual } from './value-equality.js';

/**
 * List methods of the rules language, shared by the Firestore simulator and
 * the Storage evaluator: `concat()`, `removeAll()` and `join()`, which take a
 * List or string argument, and the element tests of a List receiver's
 * `hasAll()`, `hasAny()` and `hasOnly()`.
 *
 * Each takes exactly one argument. A missing or extra argument is
 * `Incorrect number of arguments.`, and an argument of the wrong type, a Set
 * included, is an unsupported operation naming the one overload. `join()`
 * converts each element as `string()` does, so an int, float, bool, null or
 * path element is text and a List, Map or Bytes element is `string()`'s
 * error. `removeAll()` and the membership tests compare elements under
 * `listElementsEqual`, so an int never matches the equal float. The corpus
 * scenarios `upload-primitives-boundaries` (Storage) and
 * `list-methods-concat-removeall-toset` (Firestore) record production's
 * verdicts and messages for every shape, which are the same in both services.
 *
 * The receiver is already a List. A method named in `LIST_METHOD_NAMES` on a
 * string or Map receiver, and `concat()`, `join()`, `removeAll()` or
 * `toSet()` on a Set, is `functionNotFoundMessage`'s error, which a caller
 * reports itself. A failure is returned as a `ListMethodFailure` carrying
 * production's message. Each evaluator turns it into its own error value, so
 * `&&` and `||` can absorb it.
 */
export class ListMethodFailure {
  constructor(readonly message: string) {}
}

const STRING = conversionFor('string')!;

/** The single argument of `list.<method>(<type>)`, or production's failure. */
function singleArgument(
  method: string,
  expected: 'list' | 'string',
  args: readonly unknown[],
): unknown | ListMethodFailure {
  if (args.length !== 1) {
    return new ListMethodFailure(
      `Incorrect number of arguments. Received: ${args.length}. Expected: list.${method}(${expected}).`,
    );
  }
  const [arg] = args;
  const matches = expected === 'list' ? Array.isArray(arg) : typeof arg === 'string';
  if (!matches) {
    return new ListMethodFailure(
      `Unsupported operation error. Received: list.${method}(${describeRulesType(arg)}). Expected: list.${method}(${expected}).`,
    );
  }
  return arg;
}

/** `list.concat(other)`: the receiver's elements, then the argument's. */
export function listConcat(receiver: readonly unknown[], args: readonly unknown[]): unknown[] | ListMethodFailure {
  const other = singleArgument('concat', 'list', args);
  if (other instanceof ListMethodFailure) return other;
  return [...receiver, ...(other as unknown[])];
}

/** `list.removeAll(other)`: the receiver without any element that matches one in the argument. */
export function listRemoveAll(receiver: readonly unknown[], args: readonly unknown[]): unknown[] | ListMethodFailure {
  const other = singleArgument('removeAll', 'list', args);
  if (other instanceof ListMethodFailure) return other;
  return receiver.filter((value) => !(other as unknown[]).some((removed) => listElementsEqual(value, removed)));
}

/** The List methods that test a List receiver's elements against a List argument. */
export type ListMembershipMethod = 'hasAll' | 'hasAny' | 'hasOnly';

/**
 * `list.hasAll(other)`, `list.hasAny(other)` and `list.hasOnly(other)`.
 * The argument is one List; a Set, string, Map or null argument is an
 * unsupported operation, as it is in both services.
 */
export function listMembership(
  method: ListMembershipMethod,
  receiver: readonly unknown[],
  args: readonly unknown[],
): boolean | ListMethodFailure {
  const candidates = singleArgument(method, 'list', args);
  if (candidates instanceof ListMethodFailure) return candidates;
  const contains = (values: readonly unknown[], value: unknown) =>
    values.some((item) => listElementsEqual(item, value));
  const list = candidates as unknown[];
  if (method === 'hasAll') return list.every((candidate) => contains(receiver, candidate));
  if (method === 'hasAny') return list.some((candidate) => contains(receiver, candidate));
  return receiver.every((member) => contains(list, member));
}

/** The List methods production captures as "Function not found error" on a string or Map receiver. */
export const LIST_METHOD_NAMES: ReadonlySet<string> = new Set([
  'concat', 'hasAll', 'hasAny', 'hasOnly', 'join', 'removeAll', 'toSet',
]);

/** `list.join(separator)`: each element as `string()` converts it, joined by the separator. */
export function listJoin(receiver: readonly unknown[], args: readonly unknown[]): string | ListMethodFailure {
  const separator = singleArgument('join', 'string', args);
  if (separator instanceof ListMethodFailure) return separator;
  const parts: string[] = [];
  for (const element of receiver) {
    const text = applyConversion(STRING, [element]);
    if (text instanceof ConversionFailure) return new ListMethodFailure(text.message);
    parts.push(text as string);
  }
  return parts.join(separator as string);
}
