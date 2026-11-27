import { RulesValue } from '../simulator/wrappers/base.js';
import { formatRulesFloat } from '../simulator/wrappers/float.js';
import { rulesFloatValue, rulesInt } from '../simulator/rules-int.js';
import {
  bindPathSegments,
  requirePathBindMap,
  validatePathBindArity,
} from '../simulator/wrappers/path.js';
import type { EvalCtx } from './rules-evaluator.js';
import { RuleEvalError } from './rules-evaluation-error.js';
import {
  evalArguments,
  functionNotFound,
  type MethodCall,
  type ReceiverMethods,
} from './rules-method-calls.js';
import { RuleError, isRuleError as isErr } from './rules-values.js';

export class StoragePath extends RulesValue {
  readonly typeName = 'path';
  /** Names bound to segments via `.bind(map)`. */
  readonly bindings: Readonly<Record<string, string>>;
  /** Segments kept as built, so an interpolated string holding `/` stays one segment. */
  #segments: readonly string[] | undefined;
  constructor(
    readonly path: string,
    bindings?: Readonly<Record<string, string>>,
  ) {
    super();
    this.bindings = Object.assign(
      Object.create(null) as Record<string, string>,
      bindings,
    );
  }
  /**
   * A path built from its segments. A path literal's interpolated string is
   * one segment even when it holds `/`, as production keeps it
   * (capture `rules-storage-h1-lookup-interpolated-slash`).
   */
  static fromSegments(segments: readonly string[], bindings?: Readonly<Record<string, string>>): StoragePath {
    const path = new StoragePath(`/${segments.join('/')}`, bindings);
    path.#segments = [...segments];
    return path;
  }
  /** The path's segments, which `path[i]` reads. */
  get segments(): string[] {
    if (this.#segments !== undefined) return [...this.#segments];
    return this.path.split('/').filter(Boolean);
  }
  bind(bindings: Record<string, unknown>): StoragePath {
    const bound = bindPathSegments(this.segments, this.bindings, bindings);
    return StoragePath.fromSegments(bound.segments, bound.bindings);
  }
  valueOf(): number {
    return NaN;
  }
  toJSON(): unknown {
    return { __type: 'path', path: this.toString() };
  }
  // Segment-by-segment equality, matching Firestore `Path.equals`: an
  // interpolated string containing `/` stays one segment and does not equal
  // a multi-segment path literal with the same joined text.
  equals(other: unknown): boolean {
    if (!isPathValue(other)) return false;
    const ours = this.segments;
    const theirs = pathValueSegments(other);
    if (ours.length !== theirs.length) return false;
    for (let i = 0; i < ours.length; i++) {
      if (ours[i] !== theirs[i]) return false;
    }
    return true;
  }
  toString(): string {
    return this.path.startsWith('/') ? this.path : `/${this.path}`;
  }
}

/** Whether a rules value has the rules type `path`. */
export function isPathValue(value: unknown): value is RulesValue {
  return (
    value instanceof StoragePath ||
    (value instanceof RulesValue && (value.typeName === 'path' || value.typeName === 'reference'))
  );
}

/** A path value's segments, as built. */
export function pathValueSegments(value: RulesValue): string[] {
  if (value instanceof StoragePath) return value.segments;
  const segs = (value as { segments?: unknown }).segments;
  if (Array.isArray(segs)) return segs.map(String);
  return String(value).split('/').filter(Boolean);
}

/**
 * The segments one `$(v)` interpolation in a path literal contributes, or
 * `undefined` when `v` has no valid path form. Production Storage Rules
 * decide by the value's rules type: a string is one segment, a rules int
 * (`rulesInt`) formats as decimal digits, a rules float (`rulesFloatValue`,
 * bare or `RulesFloat`, plus bare `-0`) formats with Java `Double.toString`
 * (`formatRulesFloat`, matching `string(float)`), and a `path` value
 * (a `{rest=**}` capture or `path()`) splices in as its segments.
 * Captures: `rules-storage-h1-lookup-interpolated-slash`,
 * `rules-storage-storage-lookup-path-interpolation`,
 * `rules-storage-h1-lookup-float-interpolation`, and
 * `rules-storage-h1-lookup-float-edge-forms` (#1815).
 */
export function interpolationSegments(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value];
  if (Object.is(value, -0)) return ['-0.0'];
  const int = rulesInt(value);
  if (int !== undefined) return [String(int)];
  const float = rulesFloatValue(value);
  if (float !== undefined) return [formatRulesFloat(float)];
  if (isPathValue(value)) return pathValueSegments(value);
  return undefined;
}

function toStoragePath(value: RulesValue): StoragePath {
  if (value instanceof StoragePath) return value;
  const existing = (value as { bindings?: Readonly<Record<string, string>> }).bindings;
  return StoragePath.fromSegments(pathValueSegments(value), existing);
}

function evalPathBind(receiver: unknown, expr: MethodCall, ctx: EvalCtx): unknown {
  if (!isPathValue(receiver)) throw functionNotFound('bind');
  const args = evalArguments(expr, ctx);
  if (isErr(args)) return args;
  try {
    validatePathBindArity(args.length);
  } catch (err) {
    throw new RuleEvalError((err as Error).message);
  }
  try {
    const mapArg = requirePathBindMap(args[0]);
    return toStoragePath(receiver).bind(mapArg);
  } catch (err) {
    return new RuleError((err as Error).message);
  }
}

export const pathMethods: ReceiverMethods = {
  bind: evalPathBind,
};
