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
import { formatRulesFloat, RulesFloat } from './float.js';

/** Recognises {name} placeholders. Spec is restrictive: identifier chars only. */
const PLACEHOLDER = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

function formatBoundSegment(name: string, value: unknown): string {
  if (value === null || value === undefined) {
    throw new TypeError(`Path.bind(): binding '${name}' must not be null`);
  }
  if (value instanceof RulesFloat) return value.toString();
  if (typeof value === 'string' || typeof value === 'bigint') return String(value);
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) return String(value);
    return formatRulesFloat(value);
  }
  throw new TypeError(`Path.bind(): binding '${name}' must be a string, int, or float`);
}

/**
 * Shared `Path.bind(map)` substitution for Firestore and Storage rules:
 * - Only `{ident}` segments are template variables (`$(ident)` is not).
 * - Every own key in `bindings` must match a `{key}` segment in `segments`,
 *   otherwise production raises `"Variable(s) <names> do not exist in the path template."`.
 * - String, int, and float values format into single segments.
 */
export function bindPathSegments(
  segments: readonly string[],
  currentBindings: Readonly<Record<string, string>>,
  bindings: Record<string, unknown>,
): { segments: string[]; bindings: Record<string, string> } {
  const templateVars = new Set<string>();
  for (const seg of segments) {
    const match = PLACEHOLDER.exec(seg);
    if (match?.[1]) templateVars.add(match[1]);
  }
  const missing: string[] = [];
  for (const key of Object.keys(bindings)) {
    if (!templateVars.has(key)) missing.push(key);
  }
  if (missing.length > 0) {
    throw new TypeError(`Variable(s) ${missing.join(', ')} do not exist in the path template.`);
  }

  const next: string[] = [];
  const nextBindings: Record<string, string> = {};
  for (const [key, val] of Object.entries(currentBindings)) {
    Object.defineProperty(nextBindings, key, {
      value: val,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  for (const seg of segments) {
    const name = PLACEHOLDER.exec(seg)?.[1];
    if (!name) {
      next.push(seg);
      continue;
    }
    if (Object.hasOwn(bindings, name)) {
      const sv = formatBoundSegment(name, bindings[name]);
      next.push(sv);
      Object.defineProperty(nextBindings, name, {
        value: sv,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else {
      next.push(seg);
    }
  }
  return { segments: next, bindings: nextBindings };
}

export class Path extends RulesValue {
  readonly typeName = 'path';

  /** Resolved-or-placeholder segments. A segment like '{uid}' is unbound. */
  readonly segments: readonly string[];

  /**
   * Named-segment bindings — populated either by `bind()` (which records the
   * name → value pair when substituting `{name}` placeholders) or by the
   * handler when constructing `request.path` from a matched rule path
   * (so `request.path.uid` returns the wildcard value from the matched
   * `match /users/{uid}/...` block). Dot and bracket access read these
   * through `index-access.ts`; a name not bound here is production's
   * undefined-property error.
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
   * Replace `{name}` placeholders with values from `bindings`, returning a
   * fresh Path. Raises when a map key is absent from the path template or a
   * bound value is null/non-scalar.
   */
  bind(bindings: Record<string, unknown>): Path {
    const bound = bindPathSegments(this.segments, this.bindings, bindings);
    return new Path(bound.segments, bound.bindings);
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
    if (other instanceof Path) {
      if (this.segments.length !== other.segments.length) return false;
      for (let i = 0; i < this.segments.length; i++) {
        if (this.segments[i] !== other.segments[i]) return false;
      }
      return true;
    }
    if (other instanceof RulesValue && other.typeName === 'path') {
      return String(other) === this.toString();
    }
    if (other instanceof RulesValue && other.typeName === 'reference') {
      return other.equals(this);
    }
    return false;
  }

  callMethod(method: string, args: unknown[]): unknown | NoOp {
    switch (method) {
      case 'bind': {
        if (args.length !== 1) {
          throw new TypeError(
            `Incorrect number of arguments. Received: ${args.length}. Expected: path.bind(map).`,
          );
        }
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
