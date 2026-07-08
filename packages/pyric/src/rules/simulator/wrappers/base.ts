/**
 * Wrapper class contract for Firestore Rules value types — see
 * REBUILD_PLAN.md Item 0.B + Item 1.
 *
 * Why an abstract base instead of duck typing: the evaluator dispatches
 * through six different code paths (rulesValuesEqual, memberAccess,
 * bracketAccess, evaluateMethodCall, evaluateBinaryOp, isExpr, inExpr).
 * Without a single base class, every new wrapper would have to be
 * registered at six sites — and forgetting one is the exact failure mode
 * 0.B is designed to prevent ("two `Timestamp` instances wrapping the
 * same millis weren't `===`, so `request.time == otherTime` always
 * denied in sim"). With this base class, every wrapper inherits all six
 * dispatch hooks for free.
 *
 * Concrete subclasses (Timestamp, Duration, Bytes, LatLng) land in
 * Item 1.1–1.4. Path lands in Item 5. This file is intentionally
 * dead code until 1.1 — landing it first makes each wrapper sub-task
 * a "fill in the blanks" exercise instead of a structural change.
 */

/**
 * Sentinel returned by `binaryOp` / `callMethod` when the wrapper does
 * not handle the requested operation/method. The evaluator interprets
 * NO_OP as "fall through" — for `binaryOp` that means try the generic
 * numeric path; for `callMethod` it means throw `UnsupportedError`.
 *
 * `Symbol.for` (registered symbol) survives module duplication that
 * can happen across bun + esbuild + node test runners — `===` checks
 * stay reliable even if `base.ts` is loaded under two different module
 * specifiers.
 */
export const NO_OP: unique symbol = Symbol.for('pyric.RulesValue.NO_OP') as never;
export type NoOp = typeof NO_OP;

export abstract class RulesValue {
  /**
   * Stable type tag for `isExpr` dispatch — must match the names emitted
   * by the parser for `is timestamp`, `is duration`, `is bytes`,
   * `is latlng`, `is path`. Lowercase, single token.
   */
  abstract readonly typeName: string;

  /**
   * Numeric coercion for any code path that bypasses `binaryOp` and
   * casts to number (legacy `as number` sites in evaluator.ts and any
   * future `String(x)` / `Number(x)` calls). The 0.B per-wrapper table
   * documents what each type returns:
   *   Timestamp / Duration → seconds*1000 + Math.round(nanos/1e6) (millis)
   *   Bytes                → data.length (byte count)
   *   LatLng / Path        → NaN (no meaningful numeric coercion)
   *
   * Returning NaN for LatLng/Path is intentional — any rule that does
   * arithmetic on them is buggy, and NaN propagation makes the failure
   * loud rather than silent. The binary op hook (`binaryOp`) catches
   * the supported cases above this fallback.
   */
  abstract valueOf(): number;

  /**
   * String coercion for map keys, regex args, path segments, the
   * `string()` builtin, and template-style concatenation. Must
   * round-trip through value-equality where the wrapper has a literal
   * form: `parseRules(toString(x)).equals(x)` for Timestamp/Duration/
   * LatLng/Path. Bytes is exempt (literal form is the base64 string,
   * but the parser side will land with hashing.* in Item 5).
   */
  abstract toString(): string;

  /**
   * JSON-serializable form for debug output and any consumer that
   * runs `JSON.stringify` on a TestResult. Returns a plain object with
   * a `__type` discriminator so the serialized form is stable across
   * releases — crucial for the parity stress harness's debugMessages.
   */
  abstract toJSON(): unknown;

  /**
   * Value equality. THE single source of truth for `==` / `!=` /
   * `rulesValuesEqual`. `===` reference equality is intentionally
   * insufficient (the 0.B failure: two `timestamp.value(1234)` calls
   * produce two distinct instances; `===` is false; rule denies).
   */
  abstract equals(other: unknown): boolean;

  /**
   * Property access for `x.field` and `x[field]`. Default returns null
   * (no such field) — the same shape Firestore rules use for missing
   * map keys, so denial behavior is consistent.
   *
   * Wrappers override only for named properties they expose. Methods
   * are NOT exposed via `field` — `x.size` evaluates the property to
   * `null`, and `x.size()` goes through `callMethod` instead.
   */
  field(_name: string): unknown {
    return null;
  }

  /**
   * Method dispatch for `x.method(args)`. Default returns NO_OP — the
   * evaluator turns NO_OP into `UnsupportedError`, which the handler
   * maps to TestResult.state = 'UNSUPPORTED' (Item 0.A). That gives
   * agents a clear "sim gap" signal rather than a silent DENY when a
   * wrapper hasn't implemented a method yet.
   *
   * Wrappers override with a switch on `method` and dispatch to their
   * own private methods. The dispatch table is intentionally not a
   * `Record<string, Function>` — keeping it as a switch lets each
   * wrapper apply its own arg validation and return-type promises
   * inline rather than forcing a uniform signature.
   */
  callMethod(_method: string, _args: unknown[]): unknown | NoOp {
    return NO_OP;
  }

  /**
   * Cross-type binary operator dispatch. Default returns NO_OP — the
   * evaluator falls through to generic numeric ops via `valueOf()`.
   *
   * Wrappers override for the operators they support. The 0.B
   * "Required dispatch changes" table specifies the cross-type
   * arithmetic each wrapper claims:
   *   Timestamp + Duration → Timestamp
   *   Timestamp - Timestamp → Duration
   *   Timestamp - Duration → Timestamp
   *   Duration ± Duration → Duration
   *   Bytes < <= > >= Bytes → lexicographic byte compare
   *
   * `==` and `!=` do NOT route through this hook — they go through
   * `rulesValuesEqual` which calls `equals()`. This split keeps the
   * "is this the same value?" question separate from "what does
   * `lhs OP rhs` evaluate to?".
   *
   * Dispatch is left-operand-only. For commutative ops where the
   * right operand is a wrapper but the left isn't (e.g. `1 + duration`),
   * the wrapper is responsible for handling reversed arguments via
   * its own `binaryOp` when called from the right — the evaluator
   * detects this by re-dispatching when `lv` isn't a wrapper but
   * `rv` is, for the symmetric ops `==`, `!=`, `+`, `*`.
   */
  binaryOp(_op: string, _other: unknown): unknown | NoOp {
    return NO_OP;
  }
}
