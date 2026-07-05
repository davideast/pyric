/**
 * Timestamp wrapper for Firestore Rules `timestamp` type — Item 1.3.
 *
 * Closes the entire `Timestamp` type gap (was "❌ entire type" in the
 * REBUILD_PLAN Reference Inventory) and the `request.time` type bug
 * (was an ISO string — see REBUILD_PLAN Risk 1).
 *
 * Reference surface (12 instance methods):
 *   date, day, dayOfWeek, dayOfYear, hours, minutes, month, nanos,
 *   seconds, time, toMillis, year
 *
 * Construction (atomic flip per REBUILD_PLAN Risk 3):
 *   - timestamp.date(y, m, d)            month is 1-based
 *   - timestamp.value(epochMs)            millis since Unix epoch
 *   - request.time                        wrapped by handler.ts
 *   - serverTimestamp sentinel resolution wrapped by handler.ts
 *
 * Internal storage per 0.C: plain `{ seconds, nanos }` Numbers.
 * Comparison and arithmetic go field-wise via binaryOp; valueOf() is a
 * legacy-fallback only and silently truncates sub-ms precision.
 *
 * Canonical form: nanos in `[0, 999_999_999]` non-negative (protobuf
 * Timestamp spec). Negative epoch seconds are allowed (pre-1970) but
 * nanos always normalize positive — `equals()` is a straight field
 * compare without per-call normalization.
 */
import { RulesValue, NO_OP, type NoOp } from './base.js';
import { Duration } from './duration.js';

const NANOS_PER_SECOND = 1_000_000_000;
const MS_PER_DAY = 86_400_000;
const SECONDS_PER_DAY = 86_400;

/**
 * Roll over-/under-flow nanos into seconds and force nanos non-negative.
 * Uses `Math.floor` (not truncation) so negative nanos correctly borrow
 * a second: `(0, -1)` → `(-1, 999_999_999)` rather than `(0, -1)`.
 */
function normalize(seconds: number, nanos: number): { seconds: number; nanos: number } {
  const carry = Math.floor(nanos / NANOS_PER_SECOND);
  return {
    seconds: seconds + carry,
    nanos: nanos - carry * NANOS_PER_SECOND,
  };
}

export class Timestamp extends RulesValue {
  readonly typeName = 'timestamp';
  readonly seconds: number;
  readonly nanos: number;

  constructor(seconds: number, nanos: number) {
    super();
    const norm = normalize(seconds, nanos);
    this.seconds = norm.seconds;
    this.nanos = norm.nanos;
  }

  /** `timestamp.value(epochMs)` — milliseconds since Unix epoch. */
  static fromMillis(ms: number): Timestamp {
    const seconds = Math.floor(ms / 1000);
    const remainderMs = ms - seconds * 1000;
    return new Timestamp(seconds, remainderMs * 1_000_000);
  }

  /** `timestamp.date(y, m, d)` — midnight UTC; month is 1-based. */
  static fromYMD(year: number, month: number, day: number): Timestamp {
    return Timestamp.fromMillis(Date.UTC(year, month - 1, day));
  }

  /**
   * Parse an ISO-8601 string into a Timestamp. Used by `handler.ts` to
   * convert `tc.requestTime` (kept as ISO string for backwards-compat
   * with the prod Test API) into the wrapper. Sub-millisecond precision
   * in the input string is dropped because `Date.parse` only sees ms —
   * acceptable here because `tc.requestTime` is a developer-facing pin
   * (no nanosecond precision test exists for it).
   */
  static fromIsoString(iso: string): Timestamp {
    return Timestamp.fromMillis(Date.parse(iso));
  }

  toMillis(): number {
    return this.seconds * 1000 + Math.floor(this.nanos / 1_000_000);
  }

  /**
   * Convert to a JavaScript `Date` (millisecond precision).
   * Sub-millisecond nanos are dropped — same behaviour as the real
   * `firebase/firestore` `Timestamp.toDate()`.
   */
  toDate(): Date {
    return new Date(this.toMillis());
  }

  valueOf(): number {
    return this.toMillis();
  }

  /**
   * ISO-8601 UTC with 9-digit nanosecond precision. Standard
   * `Date.toISOString()` only carries millisecond precision; we
   * substitute the full nanos to preserve sub-ms detail for
   * debugMessages.
   */
  toString(): string {
    const isoMs = new Date(this.toMillis()).toISOString();
    const nanoStr = this.nanos.toString().padStart(9, '0');
    return isoMs.replace(/\.\d{3}Z$/, `.${nanoStr}Z`);
  }

  toJSON(): unknown {
    return { __type: 'timestamp', seconds: this.seconds, nanos: this.nanos };
  }

  equals(other: unknown): boolean {
    return (
      other instanceof Timestamp &&
      this.seconds === other.seconds &&
      this.nanos === other.nanos
    );
  }

  /**
   * Date components (year/month/day/hours/etc.) derive from JS `Date`
   * which only handles millisecond precision. The Timestamp's `seconds`
   * field already encodes whole-seconds, so date math is exact even
   * when sub-ms nanos are present. `dayOfWeek` follows ISO 8601:
   * Monday = 1, Sunday = 7.
   */
  callMethod(method: string, _args: unknown[]): unknown | NoOp {
    switch (method) {
      case 'seconds':
        return this.seconds;
      case 'nanos':
        return this.nanos;
      case 'toMillis':
        return this.toMillis();
      case 'year':
        return this.asDate().getUTCFullYear();
      case 'month':
        return this.asDate().getUTCMonth() + 1;
      case 'day':
        return this.asDate().getUTCDate();
      case 'hours':
        return this.asDate().getUTCHours();
      case 'minutes':
        return this.asDate().getUTCMinutes();
      case 'dayOfWeek': {
        const jsDay = this.asDate().getUTCDay(); // 0=Sun .. 6=Sat
        return jsDay === 0 ? 7 : jsDay;
      }
      case 'dayOfYear': {
        const d = this.asDate();
        const startOfYear = Date.UTC(d.getUTCFullYear(), 0, 1);
        return Math.floor((this.toMillis() - startOfYear) / MS_PER_DAY) + 1;
      }
      case 'date':
        // Same year/month/day, time-of-day zeroed.
        return Timestamp.fromYMD(
          this.asDate().getUTCFullYear(),
          this.asDate().getUTCMonth() + 1,
          this.asDate().getUTCDate(),
        );
      case 'time': {
        // Time-of-day as Duration. Compute from seconds field directly
        // so sub-ms nanos survive (JS Date would truncate them).
        const secOfDay = ((this.seconds % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
        const h = Math.floor(secOfDay / 3600);
        const m = Math.floor((secOfDay % 3600) / 60);
        const s = secOfDay % 60;
        return Duration.fromTime(h, m, s, this.nanos);
      }
      default:
        return NO_OP;
    }
  }

  private asDate(): Date {
    return new Date(this.toMillis());
  }

  /**
   * Cross-type arithmetic per REBUILD_PLAN Operators table:
   *   Timestamp + Duration → Timestamp
   *   Timestamp - Duration → Timestamp
   *   Timestamp - Timestamp → Duration
   * Plus `< <= > >=` for two Timestamps via field-wise compareTo.
   *
   * `Duration + Timestamp` (commutative) is reachable through the
   * evaluator's right-side dispatch on `+` — Duration.binaryOp returns
   * NO_OP, then `rv` (Timestamp).binaryOp(+, lv) lands here.
   */
  binaryOp(op: string, other: unknown): unknown | NoOp {
    if (other instanceof Timestamp) {
      switch (op) {
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
    if (other instanceof Duration) {
      switch (op) {
        case '+':
          return new Timestamp(this.seconds + other.seconds, this.nanos + other.nanos);
        case '-':
          return new Timestamp(this.seconds - other.seconds, this.nanos - other.nanos);
        default:
          return NO_OP;
      }
    }
    return NO_OP;
  }

  private compareTo(other: Timestamp): number {
    if (this.seconds !== other.seconds) return this.seconds - other.seconds;
    return this.nanos - other.nanos;
  }
}
