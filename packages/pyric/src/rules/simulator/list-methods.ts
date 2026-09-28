import { ConversionFailure, applyConversion, conversionFor } from './conversions.js';
import { describeRulesType } from './rules-type.js';

/**
 * List methods of the rules language that take a List argument, shared by
 * the Firestore simulator and the Storage evaluator: `concat()`,
 * `removeAll()`, and `join()`.
 *
 * Each takes exactly one argument. A missing or extra argument is
 * `Incorrect number of arguments.`, and an argument of the wrong type, a Set
 * included, is an unsupported operation naming the one overload. `join()`
 * converts each element as `string()` does, so an int, float, bool, null or
 * path element is text and a List, Map or Bytes element is `string()`'s
 * error. The Storage corpus scenario `upload-primitives-boundaries` records
 * production's verdicts and messages for every shape.
 *
 * The receiver is already a List; a caller reports its own error for any
 * other receiver. A failure is returned as a `ListMethodFailure` carrying
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

/** `list.removeAll(other)`: the receiver without any element equal to one in the argument. */
export function listRemoveAll(
  receiver: readonly unknown[],
  args: readonly unknown[],
  equals: (left: unknown, right: unknown) => boolean,
): unknown[] | ListMethodFailure {
  const other = singleArgument('removeAll', 'list', args);
  if (other instanceof ListMethodFailure) return other;
  return receiver.filter((value) => !(other as unknown[]).some((removed) => equals(value, removed)));
}

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
