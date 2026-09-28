/**
 * The `math` namespace cases shared by the Firestore corpus scenario
 * `time-math-and-casts` and the Storage corpus scenario `math-namespace`.
 * Production evaluates each condition the same way in both services.
 *
 * `math.abs()` keeps an int an int and a float a float, and returns the int64
 * minimum unchanged, since no positive int64 equals its magnitude. `math.ceil()` and
 * `math.floor()` return a float, for an int argument too. `math.round()`
 * rounds half up and returns an int, with NaN as 0 and infinities saturated.
 * `math.sqrt()` and `math.pow()` return a float and accept ints. `math.isNaN()`
 * accepts an int or a float. Any other argument type is "Unsupported operation
 * error", a wrong argument count is "Incorrect number of arguments", and
 * `math.isInfinite()` is "Function not found error". Each failure is an error
 * value: it denies through `!`, and `|| true` absorbs it.
 */
export interface MathCase {
  key: string;
  condition: string;
  expectation: 'ALLOW' | 'DENY';
}

export const MATH_CASES: readonly MathCase[] = [
  { key: 'mathAbsInt64Min', condition: 'math.abs(-9223372036854775807 - 1) < 0 && math.abs(-9223372036854775807 - 1) == -9223372036854775807 - 1', expectation: 'ALLOW' },
  { key: 'mathAbsKeepsType', condition: 'math.abs(-2) == 2 && math.abs(-2) is int && math.abs(1) is int && math.abs(-2.5) == 2.5 && math.abs(-2.5) is float && math.abs(-1.0) is float', expectation: 'ALLOW' },
  { key: 'mathCeilFloorFloat', condition: 'math.ceil(1.5) == 2 && math.ceil(1.5) is float && math.ceil(-1.5) == -1 && math.ceil(-0.5) == 0 && math.floor(-1.5) == -2 && math.floor(2.5) == 2 && math.floor(-0.5) == -1 && math.floor(1) is float && math.ceil(1) is float', expectation: 'ALLOW' },
  { key: 'mathCeilIsInt', condition: 'math.ceil(1.5) is int', expectation: 'DENY' },
  { key: 'mathRoundHalfUpInt', condition: 'math.round(2.5) == 3 && math.round(-2.5) == -2 && math.round(-1.5) == -1 && math.round(0.5) == 1 && math.round(-0.5) == 0 && math.round(1.4) == 1 && math.round(2.5) is int && math.round(1) is int', expectation: 'ALLOW' },
  { key: 'mathRoundHalfAwayFromZero', condition: 'math.round(-2.5) == -3', expectation: 'DENY' },
  { key: 'mathRoundIsFloat', condition: 'math.round(2.5) is float', expectation: 'DENY' },
  { key: 'mathRoundNaNInfinity', condition: 'math.round(math.sqrt(-1)) == 0 && math.round(math.pow(0, -1)) > 0', expectation: 'ALLOW' },
  { key: 'mathSqrtPowFloat', condition: 'math.sqrt(4) == 2.0 && math.sqrt(4) is float && math.sqrt(2) > 1.414 && math.sqrt(2) < 1.415 && math.pow(2, 3) == 8.0 && math.pow(2, 3) is float && math.pow(2, -1) == 0.5 && math.pow(4, 0.5) == 2.0', expectation: 'ALLOW' },
  { key: 'mathNaNInfinity', condition: 'math.isNaN(math.sqrt(-1)) && !math.isNaN(1) && !math.isNaN(1.0) && !math.isNaN(math.pow(0, -1)) && math.pow(0, -1) > 1000000000.0', expectation: 'ALLOW' },
  { key: 'mathAbsString', condition: "!(math.abs('a') == 1)", expectation: 'DENY' },
  { key: 'mathAbsStringOrTrue', condition: "(math.abs('a') == 1) || true", expectation: 'ALLOW' },
  { key: 'mathAbsBool', condition: '!(math.abs(true) == 1)', expectation: 'DENY' },
  { key: 'mathAbsNull', condition: '!(math.abs(null) == 1)', expectation: 'DENY' },
  { key: 'mathCeilString', condition: "!(math.ceil('a') == 1)", expectation: 'DENY' },
  { key: 'mathSqrtString', condition: "!(math.sqrt('a') == 1)", expectation: 'DENY' },
  { key: 'mathPowString', condition: "!(math.pow(2, 'a') == 1)", expectation: 'DENY' },
  { key: 'mathIsNaNString', condition: "!math.isNaN('a')", expectation: 'DENY' },
  { key: 'mathAbsTwoArgs', condition: '!(math.abs(1, 2) == 1)', expectation: 'DENY' },
  { key: 'mathSqrtNoArgs', condition: '!(math.sqrt() == 1)', expectation: 'DENY' },
  { key: 'mathIsInfinite', condition: 'math.isInfinite(1.0) == false', expectation: 'DENY' },
  { key: 'mathIsInfiniteOrTrue', condition: 'math.isInfinite(1.0) || true', expectation: 'ALLOW' },
  { key: 'mathIsInfiniteAndFalse', condition: '!(math.isInfinite(1.0) && false)', expectation: 'ALLOW' },
];
