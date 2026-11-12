/**
 * Item 4.3 — Recursive walker that resolves `{ $expr: "..." }`
 * wrappers anywhere in a write `data` tree.
 *
 * Contract:
 *  - Walks the input tree once. Returns a NEW tree (the input is
 *    never mutated).
 *  - A wrapper is exactly an object whose ONLY key is `$expr` and
 *    whose `$expr` value is a string. Any other shape with `$expr`
 *    (extra keys, non-string value) throws `ExpressionWalkError`
 *    with `code: 'invalid-argument'`.
 *  - Arrays preserve length and order; wrappers inside arrays are
 *    resolved in place.
 *  - The walker DOES NOT recurse into eval results. If `$expr`
 *    resolves to an object containing a `$expr` key (e.g. from a
 *    doc read), that nested key is treated as data — not a wrapper.
 *  - Errors include a path string (`users.0.balance`) so agents can
 *    locate the offending leaf.
 *
 * Pre-mortem-locked behaviors:
 *  - `null` is a literal value, NOT a target for descent.
 *  - Top-level `{ $expr: ... }` is allowed. The tool layer enforces
 *    that the *resolved* top-level data is a plain object before
 *    handing to the simulator.
 *  - Sentinel passthrough objects (`{ __type: '...' }`) returned by
 *    eval are leaf values — the walker doesn't descend into them.
 */
import {
  type AstNode,
  type Position,
  ExpressionLexError,
  ExpressionParseError,
} from './types.js';
import { tokenize } from './lexer.js';
import { parse } from './parser.js';
import { evaluate } from './evaluator.js';
import {
  EvalError,
  type EvalEnv,
  type EvalValue,
} from './eval-errors.js';

const EXPR_WRAPPER_KEY = '$expr';

/**
 * Errors raised by the walker for shape violations (ambiguous wrapper,
 * non-string `$expr` value). Distinct from `EvalError` so the tool
 * layer can label the failure precisely.
 */
export class ExpressionWalkError extends Error {
  readonly code = 'invalid-argument' as const;
  /** Dotted path to the offending node, e.g. `users.0.balance`. */
  readonly path: string;
  constructor(message: string, path: string) {
    super(message);
    this.name = 'ExpressionWalkError';
    this.path = path;
  }
}

/**
 * Returned alongside throws so the tool layer can map a walker /
 * eval failure to a position-bearing response.
 */
export interface WalkContext {
  /** Source-string of the most recently parsed expression, if any. */
  lastExpressionSource?: string;
  /** Source position within `lastExpressionSource`, if applicable. */
  lastExpressionPosition?: Position;
}

export function resolveExpressionsInData(
  data: unknown,
  env: EvalEnv,
): unknown {
  return walk(data, env, '');
}

function walk(value: unknown, env: EvalEnv, path: string): unknown {
  // Primitives and null pass through unchanged.
  if (value === null) return null;
  if (typeof value !== 'object') return value;

  // Arrays — preserve length, walk each element.
  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i += 1) {
      out[i] = walk(value[i], env, path === '' ? String(i) : `${path}.${i}`);
    }
    return out;
  }

  // Plain objects. First check for the `$expr` wrapper.
  const obj = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(obj, EXPR_WRAPPER_KEY)) {
    return resolveWrapper(obj, env, path);
  }

  // Regular object — walk each value. (Iterate own keys only; skip
  // anything inherited from prototype if a malicious shape were
  // constructed via `Object.create`.)
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    result[key] = walk(obj[key], env, path === '' ? key : `${path}.${key}`);
  }
  return result;
}

/**
 * `obj` has a `$expr` key. Validate the wrapper shape, parse +
 * evaluate, and return the result. Throws `ExpressionWalkError` for
 * shape problems; eval errors are re-thrown unchanged so the caller
 * can pick up the AST position.
 */
function resolveWrapper(
  obj: Record<string, unknown>,
  env: EvalEnv,
  path: string,
): unknown {
  const keys = Object.keys(obj);
  if (keys.length !== 1) {
    throw new ExpressionWalkError(
      `expression wrapper at '${path || '<root>'}' must have only the '$expr' key, got [${keys.map((k) => JSON.stringify(k)).join(', ')}]`,
      path,
    );
  }
  const exprValue = obj[EXPR_WRAPPER_KEY];
  if (typeof exprValue !== 'string') {
    throw new ExpressionWalkError(
      `'$expr' value at '${path || '<root>'}' must be a string, got ${describeUnknown(exprValue)}`,
      path,
    );
  }
  const ast = parseAndCache(exprValue, path);
  const value = evaluateWrapper(ast, env, path);
  return value as EvalValue;
}

/**
 * Evaluate an expression and re-tag any error with the wrapper path
 * so downstream messages can say *which* `$expr` failed.
 *
 * Eval errors (`EvalError`) keep their original `code` and `pos`;
 * we just wrap the message. The `cause` chain preserves the original
 * stack for debugging.
 */
function evaluateWrapper(ast: AstNode, env: EvalEnv, path: string): unknown {
  try {
    return evaluate(ast, env);
  } catch (e) {
    if (e instanceof EvalError) {
      const wrapped = new EvalError(
        e.code,
        `at '${path || '<root>'}': ${e.message}`,
        e.pos,
      );
      // Preserve the original via `cause` so stack traces still show
      // the underlying failure.
      (wrapped as { cause?: unknown }).cause = e;
      throw wrapped;
    }
    throw e;
  }
}

/**
 * Parse the expression source. We don't cache across walks — each
 * `walk-data` call is one tx invocation, so re-parsing is cheap and
 * the per-call cap (256 chars) makes this a non-issue. The function
 * exists to centralize parse-error tagging.
 *
 * Re-tagging is done with explicit `instanceof` switches over the
 * known error classes (`ExpressionLexError`, `ExpressionParseError`)
 * rather than `new (e.constructor as typeof Error)(...)`. The
 * reflection form silently degrades to a plain `Error` if a future
 * caller throws a different subclass, dropping `code`/`pos`. Explicit
 * switches let the type checker enforce that every known error class
 * is handled.
 */
function parseAndCache(src: string, path: string): AstNode {
  try {
    return parse(tokenize(src));
  } catch (e) {
    if (e instanceof ExpressionLexError) {
      throw retagLexOrParseError(e, ExpressionLexError, path);
    }
    if (e instanceof ExpressionParseError) {
      throw retagLexOrParseError(e, ExpressionParseError, path);
    }
    throw e;
  }
}

/**
 * Construct a fresh error of the same class, preserving `pos` and
 * chaining the original via `cause`. Path-prefixed message keeps the
 * agent oriented to where in the data tree the failure occurred.
 */
function retagLexOrParseError<E extends ExpressionLexError | ExpressionParseError>(
  original: E,
  ctor: new (message: string, pos: Position) => E,
  path: string,
): E {
  const wrapped = new ctor(
    `at '${path || '<root>'}': ${original.message}`,
    original.pos,
  );
  (wrapped as { cause?: unknown }).cause = original;
  return wrapped;
}

function describeUnknown(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
