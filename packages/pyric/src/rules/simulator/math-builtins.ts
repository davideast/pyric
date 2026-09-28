import { describeRulesType } from './rules-type.js';
import { RulesFloat } from './wrappers/float.js';

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

interface MathFunction {
  /** The overload list production prints in its argument errors. */
  readonly overloads: string;
  readonly arity: number;
  apply(args: readonly number[], floats: readonly boolean[]): unknown;
}

const INT64_MIN = -(2 ** 63);
const INT64_MAX = 2 ** 63;

/** Round half up to an int, NaN as 0, saturated at the int64 bounds. */
function roundToInt(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value <= INT64_MIN) return INT64_MIN;
  if (value >= INT64_MAX) return INT64_MAX;
  return Math.round(value) + 0; // + 0 turns -0 into 0
}

const float = (value: number) => new RulesFloat(value);

const MATH: ReadonlyMap<string, MathFunction> = new Map<string, MathFunction>([
  ['abs', {
    overloads: 'math.abs(int), math.abs(float)',
    arity: 1,
    // The int64 minimum has no positive int64: production returns it unchanged.
    apply: ([x], [isFloat]) => (isFloat ? float(Math.abs(x!)) : x === INT64_MIN ? x : Math.abs(x!)),
  }],
  ['ceil', { overloads: 'math.ceil(float)', arity: 1, apply: ([x]) => float(Math.ceil(x!)) }],
  ['floor', { overloads: 'math.floor(float)', arity: 1, apply: ([x]) => float(Math.floor(x!)) }],
  ['round', { overloads: 'math.round(float)', arity: 1, apply: ([x]) => roundToInt(x!) }],
  ['sqrt', { overloads: 'math.sqrt(float)', arity: 1, apply: ([x]) => float(Math.sqrt(x!)) }],
  ['pow', { overloads: 'math.pow(float, float)', arity: 2, apply: ([x, y]) => float(Math.pow(x!, y!)) }],
  ['isNaN', { overloads: 'math.isNaN(float)', arity: 1, apply: ([x]) => Number.isNaN(x!) }],
]);

/** The numeric value of an int or float argument, or undefined for any other type. */
function numeric(value: unknown): { value: number; isFloat: boolean } | undefined {
  if (value instanceof RulesFloat) return { value: value.value, isFloat: true };
  if (typeof value === 'number') return { value, isFloat: !Number.isInteger(value) };
  return undefined;
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
  return fn.apply(numbers.map((n) => n!.value), numbers.map((n) => n!.isFloat));
}
