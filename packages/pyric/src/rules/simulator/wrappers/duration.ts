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
import { RulesValue, NO_OP, ValueRangeError, type NoOp } from './base.js';

const NANOS_PER_SECOND = 1_000_000_000;
/** The protobuf Duration bound, about 10,000 years either way. */
const MAX_SECONDS = 315_576_000_000;
/** Production's evaluation error for a duration past the bound, from the capture's diagnostics. */
export const DURATION_NOT_VALID =
  'Duration is not valid. Seconds must be in range [-315,576,000,000, +315,576,000,000]. Nanos must be in range [-999,999,999, +999,999,999]. Nanos must have the same sign as seconds.';

const BIG_NANOS_PER_SECOND = 1_000_000_000n;
const BIG_MAX_SECONDS = 315_576_000_000n;

/** Nanoseconds in one of each `duration.value()` unit. */
const NANOS_PER_UNIT: Readonly<Record<string, bigint>> = {
  w: 7n * 24n * 60n * 60n * BIG_NANOS_PER_SECOND,
  d: 24n * 60n * 60n * BIG_NANOS_PER_SECOND,
  h: 60n * 60n * BIG_NANOS_PER_SECOND,
  m: 60n * BIG_NANOS_PER_SECOND,
  s: BIG_NANOS_PER_SECOND,
  ms: 1_000_000n,
  ns: 1n,
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

/** True for whole seconds inside the protobuf bound; false for NaN and infinities. */
function isInRange(seconds: number): boolean {
  return Number.isFinite(seconds) && Math.abs(seconds) <= MAX_SECONDS;
}

export class Duration extends RulesValue {
  readonly typeName = 'duration';
  readonly seconds: number;
  readonly nanos: number;

  /**
   * Throws production's "Duration is not valid" error (a {@link ValueRangeError}) when
   * the normalized seconds are past the protobuf bound or not finite, so
   * `duration.value()`, `duration.time()` and duration arithmetic past the
   * bound never become a value.
   */
  constructor(seconds: number, nanos: number) {
    super();
    const norm = normalize(seconds, nanos);
    if (!isInRange(norm.seconds)) throw new ValueRangeError(DURATION_NOT_VALID);
    this.seconds = norm.seconds;
    this.nanos = norm.nanos;
  }

  /**
   * `duration.value(magnitude, unit)`. The magnitude is an int64 (a bigint,
   * or an integral number from a host value). The magnitude converts to whole
   * nanoseconds in bigint math, so `2500` ns doesn't become `2.5e-6`
   * seconds and an `ns` magnitude above 2^53 keeps every digit.
   */
  static fromValue(magnitude: bigint | number, unit: string): Duration {
    const nanosPerUnit = Object.hasOwn(NANOS_PER_UNIT, unit) ? NANOS_PER_UNIT[unit] : undefined;
    if (nanosPerUnit === undefined) {
      throw new Error(
        `Unknown duration unit '${unit}' (expected one of: w, d, h, m, s, ms, ns)`,
      );
    }
    // The public `duration()` value helper may pass a fractional magnitude,
    // which rounds to the nearest nanosecond.
    const fractional = typeof magnitude === 'number' && !Number.isInteger(magnitude);
    if (fractional) return Duration.fromNanos(BigInt(Math.round(magnitude * Number(nanosPerUnit))));
    return Duration.fromNanos(BigInt(magnitude) * nanosPerUnit);
  }

  /** `duration.time(h, m, s, ns)`, each an int64, summed in bigint math. */
  static fromTime(h: bigint | number, m: bigint | number, s: bigint | number, ns: bigint | number): Duration {
    const seconds = BigInt(h) * 3600n + BigInt(m) * 60n + BigInt(s);
    return Duration.fromNanos(seconds * BIG_NANOS_PER_SECOND + BigInt(ns));
  }

  /**
   * The duration of `total` nanoseconds. Past the protobuf bound it is
   * production's "Duration is not valid" error, decided before the seconds
   * become a JavaScript number.
   */
  private static fromNanos(total: bigint): Duration {
    const seconds = total / BIG_NANOS_PER_SECOND;
    if (seconds > BIG_MAX_SECONDS || seconds < -BIG_MAX_SECONDS) throw new ValueRangeError(DURATION_NOT_VALID);
    return new Duration(Number(seconds), Number(total % BIG_NANOS_PER_SECOND));
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
   * Unary minus, `-d`. Canonical form keeps both fields the same sign and
   * the range bound is symmetric, so negating a valid duration is valid.
   */
  negated(): Duration {
    return new Duration(-this.seconds, -this.nanos);
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

  callMethod(method: string, args: unknown[]): unknown | NoOp {
    switch (method) {
      case 'seconds':
      case 'nanos':
        if (args.length !== 0) {
          throw new RangeError(
            `Incorrect number of arguments. Received: ${args.length}. Expected: duration.${method}().`,
          );
        }
        return method === 'seconds' ? this.seconds : this.nanos;
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
