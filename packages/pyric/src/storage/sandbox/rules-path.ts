import { isRulesMap } from '../../rules/simulator/rules-type.js';
import { RulesValue } from '../../rules/simulator/wrappers/base.js';
import type { EvalCtx } from './rules-evaluator.js';
import { RuleEvalError } from './rules-evaluation-error.js';
import {
  evalArguments,
  functionNotFound,
  type MethodCall,
  type ReceiverMethods,
} from './rules-method-calls.js';
import { RuleError, isRuleError as isErr } from './rules-values.js';

const PLACEHOLDER = /^(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|\$\(([A-Za-z_][A-Za-z0-9_]*)\))$/;

export class StoragePath extends RulesValue {
  readonly typeName = 'path';
  /** Names bound to segments via `.bind(map)`. */
  readonly bindings: Readonly<Record<string, string>>;
  /** Segments kept as built, so an interpolated string holding `/` stays one segment. */
  #segments: readonly string[] | undefined;
  constructor(
    readonly path: string,
    bindings: Readonly<Record<string, string>> = {},
  ) {
    super();
    this.bindings = bindings;
  }
  /**
   * A path built from its segments. A path literal's interpolated string is
   * one segment even when it holds `/`, as production keeps it
   * (capture `rules-storage-h1-lookup-interpolated-slash`).
   */
  static fromSegments(segments: readonly string[], bindings: Readonly<Record<string, string>> = {}): StoragePath {
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
    const next: string[] = [];
    const nextBindings: Record<string, string> = { ...this.bindings };
    for (const seg of this.segments) {
      const m = PLACEHOLDER.exec(seg);
      if (!m) {
        next.push(seg);
        continue;
      }
      const name = (m[1] ?? m[2])!;
      if (Object.hasOwn(bindings, name)) {
        const v = bindings[name];
        if (v === null || v === undefined || (typeof v !== 'string' && typeof v !== 'number')) {
          throw new TypeError(`Path.bind(): binding '${name}' must not be null`);
        }
        const sv = String(v);
        next.push(sv);
        nextBindings[name] = sv;
      } else {
        next.push(seg);
      }
    }
    return StoragePath.fromSegments(next, nextBindings);
  }
  valueOf(): number {
    return NaN;
  }
  toJSON(): unknown {
    return { __type: 'path', path: this.toString() };
  }
  // Equality and `string()` use the joined form, so `['users', 'a/b']`
  // equals `path('/users/a/b')`. No capture shows production comparing a
  // slashed segment; this stays until one does.
  equals(other: unknown): boolean {
    return (
      (other instanceof StoragePath || (other instanceof RulesValue && other.typeName === 'path')) &&
      String(other) === this.toString()
    );
  }
  toString(): string {
    return this.path.startsWith('/') ? this.path : `/${this.path}`;
  }
}

/** Whether a rules value has the rules type `path`. */
export function isPathValue(value: unknown): value is RulesValue {
  return value instanceof StoragePath || (value instanceof RulesValue && value.typeName === 'path');
}

/** A path value's segments, as built. */
export function pathValueSegments(value: RulesValue): string[] {
  if (value instanceof StoragePath) return value.segments;
  return String(value).split('/').filter(Boolean);
}

/**
 * The segments one `$(v)` interpolation in a path literal contributes, or
 * `undefined` when `v` has no path form. Production decides by the value's
 * rules type, not its contents: a string or number is exactly one segment,
 * even when it holds a `/`, and a `path` value (a `{rest=**}` capture or
 * `path()`) splices in as its segments (captures
 * `rules-storage-h1-lookup-interpolated-slash` and
 * `rules-storage-storage-lookup-path-interpolation`).
 */
export function interpolationSegments(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value];
  if (typeof value === 'number') return [String(value)];
  if (isPathValue(value)) return pathValueSegments(value);
  return undefined;
}

function evalPathBind(receiver: unknown, expr: MethodCall, ctx: EvalCtx): unknown {
  if (!(receiver instanceof StoragePath)) throw functionNotFound('bind');
  const args = evalArguments(expr, ctx);
  if (isErr(args)) return args;
  if (args.length !== 1) {
    throw new RuleEvalError(`Incorrect number of arguments. Received: ${args.length}. Expected: path.bind(map).`);
  }
  const [m] = args;
  if (!isRulesMap(m)) {
    return new RuleError('path.bind() requires a map argument');
  }
  try {
    return receiver.bind(m);
  } catch (err) {
    return new RuleError((err as Error).message);
  }
}

export const pathMethods: ReceiverMethods = {
  bind: evalPathBind,
};
