/**
 * RULES-B5 — int/float type distinction in the rules value model.
 *
 * Firestore Security Rules (CEL) has two distinct numeric types, `int`
 * (INT64) and `float` (FLOAT64). The JS host has only one `number`, so
 * `1` and `1.0` are indistinguishable at the host level — which is why
 * the pre-fix evaluator reported `1.5 is int` → true and `1 is float` →
 * true, and did float division for `10 / 4` (→ 2.5, where prod truncates
 * int÷int to 2). See findings-ledger RULES-B5.
 *
 * The fix tags FLOAT values with this lightweight wrapper while bare JS
 * `number` continues to mean `int`. Why wrap floats (not ints): integers
 * are overwhelmingly the common case in rules data (counts, sizes, list
 * indices, `request.time` millis), and every existing `typeof x ===
 * 'number'` site already treats a bare number as an int — so wrapping the
 * rarer float keeps the blast radius small. The evaluator unwraps floats
 * at arithmetic/comparison boundaries via `numericValue()` and re-tags
 * the result when either operand was a float.
 *
 * `is float` ↔ `value instanceof RulesFloat`; `is int` ↔ bare number.
 * `string()` of a float keeps its decimal (`string(1.0)` → "1.0").
 *
 * Doc/oracle: https://firebase.google.com/docs/reference/rules/rules.Float
 * (distinct Float type) + the CEL int/float division spec (int÷int
 * truncates, int÷0 errors, float÷0 → NaN).
 */
import { RulesValue, NO_OP, type NoOp } from './base.js';

export class RulesFloat extends RulesValue {
  readonly typeName = 'float';
  readonly value: number;

  constructor(value: number) {
    super();
    this.value = value;
  }

  /** Numeric coercion — float arithmetic unwraps to this raw double. */
  valueOf(): number {
    return this.value;
  }

  /**
   * `string()` of a float keeps a decimal point so the int/float
   * distinction survives the cast: `string(1.0)` → "1.0", not "1".
   * Non-integral floats stringify naturally (`string(1.5)` → "1.5").
   */
  toString(): string {
    return Number.isInteger(this.value) ? `${this.value}.0` : String(this.value);
  }

  toJSON(): unknown {
    return { __type: 'float', value: this.value };
  }

  equals(other: unknown): boolean {
    // CEL compares int and float by numeric value (`1 == 1.0` → true), so
    // equality unwraps both sides rather than gating on `instanceof`.
    if (other instanceof RulesFloat) return this.value === other.value;
    if (typeof other === 'number') return this.value === other;
    return false;
  }

  /**
   * Float participates in arithmetic/comparison against bare-number ints
   * and other floats. A float operand always yields a float result (CEL
   * has no int÷float→int narrowing); division by zero is FLOAT division so
   * it produces NaN (caller decides storeability) rather than erroring the
   * way int÷0 does. NO_OP for any non-numeric operand so the evaluator's
   * type-mismatch guard surfaces e.g. `1.5 + 'a'` as a real error.
   */
  binaryOp(op: string, other: unknown): unknown | NoOp {
    const r =
      other instanceof RulesFloat ? other.value
      : typeof other === 'number' ? other
      : undefined;
    if (r === undefined) return NO_OP;
    const l = this.value;
    switch (op) {
      case '+': return new RulesFloat(l + r);
      case '-': return new RulesFloat(l - r);
      case '*': return new RulesFloat(l * r);
      case '/': return new RulesFloat(l / r); // float ÷ 0 → ±Infinity / NaN
      case '%': return new RulesFloat(l % r);
      case '<': return l < r;
      case '<=': return l <= r;
      case '>': return l > r;
      case '>=': return l >= r;
      default: return NO_OP;
    }
  }
}
