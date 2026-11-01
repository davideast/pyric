import { describeRulesType } from './rules-type.js';
import { RulesFloat } from './wrappers/float.js';
import { INT64_MIN, roundToInt, rulesFloatValue, rulesInt } from './rules-int.js';

/**
 * The `math` namespace of the rules language. Firestore and Storage rules
 * share it, and both evaluators call `applyMath`. The corpus scenarios
 * `time-math-and-casts` (Firestore) and `math-namespace` (Storage) record
 * the production verdicts, from one case table
 * (`packages/conformance/src/rules-math-cases.ts`).
 *
 *  - `abs` keeps an int an int and a float a float; the int64 minimum
 *    stays negative, as it does in production.
 *  - `ceil` and `floor` return a float, for an int argument too.
 *  - `round` rounds half up and returns an int: NaN is 0 and an infinity
 *    saturates at the int64 bounds.
 *  - `sqrt` and `pow` return a float; `isNaN` returns a bool. Each accepts an
 *    int as well as a float.
 *
 * Another argument type is "Unsupported operation error", a wrong argument
 * count is "Incorrect number of arguments", and a name the namespace does
 * not define (`math.isInfinite`, which the rules reference lists) is
 * "Function not found error". Each is returned as a `MathFailure` carrying
 * production's message; the evaluator turns it into its own error value, so
 * `&&` and `||` can absorb it.
 */
export class MathFailure {
  constructor(readonly message: string) {}
}

/** An int or float argument: `int` holds an int's exact value, `value` its double. */
interface MathArgument {
  value: number;
  int?: bigint;
}

interface MathFunction {
  /** The overload list production prints in its argument errors. */
  readonly overloads: string;
  readonly arity: number;
  apply(args: readonly MathArgument[]): unknown;
}

const float = (value: number) => new RulesFloat(value);

/** `math.abs` of an int: the int64 minimum has no positive int64, and production returns it unchanged. */
function absInt(value: bigint): bigint {
  return value < 0n && value !== INT64_MIN ? -value : value;
}

const MATH: ReadonlyMap<string, MathFunction> = new Map<string, MathFunction>([
  ['abs', {
    overloads: 'math.abs(int), math.abs(float)',
    arity: 1,
    apply: ([x]) => (x!.int === undefined ? float(Math.abs(x!.value)) : absInt(x!.int)),
  }],
  ['ceil', { overloads: 'math.ceil(float)', arity: 1, apply: ([x]) => float(Math.ceil(x!.value)) }],
  ['floor', { overloads: 'math.floor(float)', arity: 1, apply: ([x]) => float(Math.floor(x!.value)) }],
  ['round', { overloads: 'math.round(float)', arity: 1, apply: ([x]) => x!.int ?? roundToInt(x!.value) }],
  ['sqrt', { overloads: 'math.sqrt(float)', arity: 1, apply: ([x]) => float(Math.sqrt(x!.value)) }],
  ['pow', { overloads: 'math.pow(float, float)', arity: 2, apply: ([x, y]) => float(Math.pow(x!.value, y!.value)) }],
  ['isNaN', { overloads: 'math.isNaN(float)', arity: 1, apply: ([x]) => Number.isNaN(x!.value) }],
]);

/** An int or float argument, or undefined for any other type. */
function numeric(value: unknown): MathArgument | undefined {
  const int = rulesInt(value);
  if (int !== undefined) return { value: Number(int), int };
  const double = rulesFloatValue(value);
  return double === undefined ? undefined : { value: double };
}

/** Apply `math.<name>` to its evaluated arguments. */
export function applyMath(name: string, args: readonly unknown[]): unknown {
  const fn = MATH.get(name);
  if (!fn) return new MathFailure(`Function not found error: Name: [math.${name}].`);
  if (args.length !== fn.arity) {
    return new MathFailure(`Incorrect number of arguments. Received: ${args.length}. Expected: ${fn.overloads}.`);
  }
  const numbers = args.map(numeric);
  if (numbers.some((n) => n === undefined)) {
    return new MathFailure(
      `Unsupported operation error. Received: math.${name}(${args.map(describeRulesType).join(', ')}). Expected: ${fn.overloads}.`,
    );
  }
  return fn.apply(numbers as MathArgument[]);
}
