/**
 * Path wrapper — Item 5.4 of REBUILD_PLAN.md.
 *
 * Reference surface (rules.Path):
 *   bind(map: Map) → Path    substitutes {placeholder} segments; null vals reject
 *   Operators: ==, dot x.f, numeric x[i], named x[name]
 *   Constructed via literal `/path/to/resource` or `path("path/to/resource")`
 *
 * Per 0.B per-wrapper table:
 *   typeName: 'path'
 *   valueOf:  NaN          (no meaningful numeric coercion)
 *   toString: '/seg1/seg2' (round-trips with literal form)
 *   equals:   segment-by-segment string equality
 *   binaryOp: NO_OP (== / != route through equals; no <,> on paths)
 *
 * Path was deferred from Item 1 because its only construction site is the
 * `path()` builtin (Item 5) and the `/foo/$(x)/` literal form. Landing the
 * wrapper now lets `pathLiteral` evaluation flip from "string" to "Path"
 * so `is path` works correctly without breaking get/exists (which already
 * String()-coerce their argument).
 *
 * Segments may include `{name}` placeholders. `bind()` replaces them in
 * one shot, returning a fresh Path. The wrapper does NOT enforce that
 * all placeholders are bound — leaving that to the consumer (get/exists)
 * makes parity behavior obvious: an unbound path renders as "/users/{uid}"
 * and the resolver returns null.
 */
import { RulesValue, NO_OP, type NoOp } from './base.js';

/** Recognises {name} placeholders. Spec is restrictive: identifier chars only. */
const PLACEHOLDER = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

export class Path extends RulesValue {
  readonly typeName = 'path';

  /** Resolved-or-placeholder segments. A segment like '{uid}' is unbound. */
  readonly segments: readonly string[];

  /**
   * Named-segment bindings — populated either by `bind()` (which records the
   * name → value pair when substituting `{name}` placeholders) or by the
   * handler when constructing `request.path` from a matched rule path
   * (so `request.path.uid` returns the wildcard value from the matched
   * `match /users/{uid}/...` block).
   *
   * Without this, `field('uid')` on a fully-bound Path returned null and
   * any rule reading named segments off `request.path` silently denied.
   */
  readonly bindings: Readonly<Record<string, string>>;

  constructor(segments: readonly string[], bindings: Record<string, string> = {}) {
    super();
    this.segments = segments;
    this.bindings = bindings;
  }

  /** Construct from a string like '/users/alice' or 'users/{uid}/posts'. */
  static fromString(s: string): Path {
    // Leading slash is conventional but optional; trim either way.
    const trimmed = s.startsWith('/') ? s.slice(1) : s;
    if (trimmed.length === 0) return new Path([]);
    return new Path(trimmed.split('/'));
  }

  /**
   * Replace `{name}` placeholders with values from `bindings`. Returns
   * a fresh Path. If a binding value is null/undefined, throws — matches
   * the rules.Path.bind() contract that "values must not be null".
   *
   * Passing a binding whose placeholder doesn't exist in the path is
   * silently allowed (consistent with how the spec says binding by extra
   * keys has no effect).
   */
  bind(bindings: Record<string, unknown>): Path {
    const next: string[] = [];
    const nextBindings: Record<string, string> = { ...this.bindings };
    for (const seg of this.segments) {
      const m = seg.match(PLACEHOLDER);
      if (!m) {
        next.push(seg);
        continue;
      }
      const name = m[1];
      if (name in bindings) {
        const v = bindings[name];
        if (v === null || v === undefined) {
          throw new TypeError(`Path.bind(): binding '${name}' must not be null`);
        }
        const sv = String(v);
        next.push(sv);
        nextBindings[name] = sv;
      } else {
        // Unbound — preserve the placeholder. get/exists will see the
        // literal `{name}` and the resolver will return null.
        next.push(seg);
      }
    }
    return new Path(next, nextBindings);
  }

  // ─── RulesValue contract ─────────────────────────────────────────────

  valueOf(): number {
    return NaN; // No meaningful numeric coercion (matches LatLng).
  }

  toString(): string {
    return '/' + this.segments.join('/');
  }

  toJSON(): unknown {
    return { __type: 'path', segments: [...this.segments] };
  }

  equals(other: unknown): boolean {
    if (!(other instanceof Path)) return false;
    if (this.segments.length !== other.segments.length) return false;
    for (let i = 0; i < this.segments.length; i++) {
      if (this.segments[i] !== other.segments[i]) return false;
    }
    return true;
  }

  /**
   * Bracket / dot field dispatch.
   *
   * Numeric string ('0', '1', ...) → returns the segment at that index,
   * null if out of bounds. The evaluator funnels both `p[0]` and `p[i]`
   * here as `String(idx)`.
   *
   * Named ('uid', etc.) → returns the value from `bindings`, populated
   * either by `bind()` or by the handler when constructing `request.path`
   * from a matched-rule path. Returns null if the name was never bound.
   */
  field(name: string): unknown {
    // Numeric index path (works for strings like '0', '12', ...)
    if (/^\d+$/.test(name)) {
      const i = Number(name);
      if (i < 0 || i >= this.segments.length) return null;
      return this.segments[i];
    }
    // Named binding lookup. Bindings are populated either by `bind()` or by
    // the handler when constructing `request.path` from a matched-rule path
    // (so wildcards from `match /users/{uid}/...` are exposed as
    // `request.path.uid`). Returns null if the name was never bound — same
    // shape as missing-map-key reads elsewhere in the evaluator.
    if (name in this.bindings) return this.bindings[name];
    return null;
  }

  callMethod(method: string, args: unknown[]): unknown | NoOp {
    switch (method) {
      case 'bind': {
        const m = args[0];
        if (m === null || m === undefined || typeof m !== 'object' || Array.isArray(m) || m instanceof RulesValue) {
          throw new TypeError(
            `Path.bind() requires a Map argument, got ${m === null ? 'null' : typeof m}`,
          );
        }
        return this.bind(m as Record<string, unknown>);
      }
      default:
        return NO_OP;
    }
  }
}
