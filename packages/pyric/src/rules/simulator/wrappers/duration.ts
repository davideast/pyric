/**
 * Duration wrapper for Firestore Rules `duration` type — Item 1.2.
 *
 * Closes the entire `Duration` type gap from REBUILD_PLAN.md (was
 * "❌ entire type" in the Reference Inventory) and the `duration.abs`
 * namespace gap.
 *
 * Reference surface (from REBUILD_PLAN.md "Reference Inventory"):
 *   - seconds() → Integer (signed, [-315_576_000_000, +315_576_000_000])
 *   - nanos()   → Integer (signed, [-999_999_999, +999_999_999])
 *   - Operators: ==, !=, <, <=, >, >=, Duration ± Duration → Duration
 *
 * Construction (all flip atomically per REBUILD_PLAN Risk 3):
 *   - duration.value(magnitude, unit)  unit ∈ w|d|h|m|s|ms|ns
 *   - duration.time(h, m, s, ns)
 *   - duration.abs(d)
 *
 * Internal storage per 0.C: plain `{ seconds, nanos }` Numbers, *not*
 * a single millis number — the millis path silently truncates
 * sub-millisecond precision. Comparison and arithmetic go through
 * field-wise math; valueOf() exists only for legacy `as number` sites
 * that don't route through binaryOp.
 *
 * Canonical form: same sign for `seconds` and `nanos`, with
 * `|nanos| < 1_000_000_000`. This matches Google's protobuf Duration
 * canonical form so `equals()` is a straight field compare without
 * normalizing on every call.
 */
import { RulesValue, NO_OP, type NoOp } from './base.js';

const NANOS_PER_SECOND = 1_000_000_000;

const SECONDS_PER_UNIT: Record<string, number> = {
  w: 7 * 24 * 60 * 60,
  d: 24 * 60 * 60,
  h: 60 * 60,
  m: 60,
  s: 1,
};

/**
 * Roll over-/under-flow nanos into seconds and force same sign for both
 * fields. Two normalization passes:
 *   1. Carry whole seconds out of nanos.
 *   2. Reconcile sign mismatch between seconds and nanos.
 *
 * Without step 2, `(1, -500_000_000)` would survive as a non-canonical
 * form, breaking `equals()` against the equivalent `(0, 500_000_000)`
 * produced by a different construction path.
 */
function normalize(seconds: number, nanos: number): { seconds: number; nanos: number } {
  let s = seconds + Math.trunc(nanos / NANOS_PER_SECOND);
  let n = nanos % NANOS_PER_SECOND;
  if (s > 0 && n < 0) {
    s -= 1;
    n += NANOS_PER_SECOND;
  } else if (s < 0 && n > 0) {
    s += 1;
    n -= NANOS_PER_SECOND;
  }
  return { seconds: s, nanos: n };
}

export class Duration extends RulesValue {
  readonly typeName = 'duration';
  readonly seconds: number;
  readonly nanos: number;

  constructor(seconds: number, nanos: number) {
    super();
    const norm = normalize(seconds, nanos);
    this.seconds = norm.seconds;
    this.nanos = norm.nanos;
  }

  /**
   * `duration.value(magnitude, unit)` — magnitude is Integer per spec.
   * For `ms` and `ns` we route through integer math so a magnitude of
   * `2500` ns doesn't become `2.5e-6` seconds (float artifact); for
   * larger units the seconds-per-unit factor is exact.
   */
  static fromValue(magnitude: number, unit: string): Duration {
    if (unit in SECONDS_PER_UNIT) {
      return new Duration(magnitude * SECONDS_PER_UNIT[unit], 0);
    }
    if (unit === 'ms') {
      const wholeSec = Math.trunc(magnitude / 1000);
      const remainderMs = magnitude - wholeSec * 1000;
      return new Duration(wholeSec, remainderMs * 1_000_000);
    }
    if (unit === 'ns') {
      const wholeSec = Math.trunc(magnitude / NANOS_PER_SECOND);
      const remainderNs = magnitude - wholeSec * NANOS_PER_SECOND;
      return new Duration(wholeSec, remainderNs);
    }
    throw new Error(
      `Unknown duration unit '${unit}' (expected one of: w, d, h, m, s, ms, ns)`,
    );
  }

  /** `duration.time(h, m, s, ns)`. */
  static fromTime(h: number, m: number, s: number, ns: number): Duration {
    return new Duration(h * 3600 + m * 60 + s, ns);
  }

  /**
   * `duration.abs(d)`. Because canonical form forces same sign for
   * both fields, we can safely take `Math.abs` of each independently
   * — there's no field-pair like `(1, -500_000_000)` to worry about.
   */
  static abs(d: Duration): Duration {
    return new Duration(Math.abs(d.seconds), Math.abs(d.nanos));
  }

  /**
   * Millisecond approximation. Used only by legacy `as number` sites
   * that bypass binaryOp; comparison/arithmetic go through binaryOp's
   * field-wise path so sub-ms precision survives. See REBUILD_PLAN 0.C.
   */
  valueOf(): number {
    return this.seconds * 1000 + Math.round(this.nanos / 1e6);
  }

  /**
   * `${signedSeconds}.${absNanos}s` with 9-digit zero-padded fractional.
   * Negative durations carry a single leading minus on the integer part
   * — `Number(toString(d))` does not need to round-trip (no parser
   * support for duration literals); this format mirrors protobuf's
   * canonical text form for debugging readability.
   */
  toString(): string {
    const negative = this.seconds < 0 || this.nanos < 0;
    const absSec = Math.abs(this.seconds);
    const absNanos = Math.abs(this.nanos);
    return `${negative ? '-' : ''}${absSec}.${absNanos.toString().padStart(9, '0')}s`;
  }

  toJSON(): unknown {
    return { __type: 'duration', seconds: this.seconds, nanos: this.nanos };
  }

  equals(other: unknown): boolean {
    return (
      other instanceof Duration &&
      this.seconds === other.seconds &&
      this.nanos === other.nanos
    );
  }

  callMethod(method: string, _args: unknown[]): unknown | NoOp {
    switch (method) {
      case 'seconds':
        return this.seconds;
      case 'nanos':
        return this.nanos;
      default:
        return NO_OP;
    }
  }

  /**
   * Duration ± Duration → Duration; Duration cmp Duration via field
   * compare. Cross-type with Timestamp lands in 1.3. NO_OP for any
   * other operand pair so the evaluator's Risk 2 guard surfaces
   * `duration + 1` etc. as a real type error, not silent NaN.
   */
  binaryOp(op: string, other: unknown): unknown | NoOp {
    if (!(other instanceof Duration)) return NO_OP;
    switch (op) {
      case '+':
        return new Duration(this.seconds + other.seconds, this.nanos + other.nanos);
      case '-':
        return new Duration(this.seconds - other.seconds, this.nanos - other.nanos);
      case '<':
        return this.compareTo(other) < 0;
      case '<=':
        return this.compareTo(other) <= 0;
      case '>':
        return this.compareTo(other) > 0;
      case '>=':
        return this.compareTo(other) >= 0;
      default:
        return NO_OP;
    }
  }

  private compareTo(other: Duration): number {
    if (this.seconds !== other.seconds) return this.seconds - other.seconds;
    return this.nanos - other.nanos;
  }
}
