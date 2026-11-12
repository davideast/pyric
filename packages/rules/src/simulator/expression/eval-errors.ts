/**
 * Item 4.2.1 — Evaluator error class + EvalEnv / EvalValue types.
 *
 * The evaluator throws `EvalError` (never any other class) so the
 * tool layer can map every failure to the right user-facing code
 * via `error.code` without instanceof-chains.
 *
 * Error codes are a closed set. Each maps to the same
 * `FirestoreErrorCode` (`invalid-argument`) at the tool boundary —
 * the granular codes exist for tests + diagnostic messages, not for
 * agent-visible discrimination.
 */
import type { AstNode, Position } from './types.js';

export const EVAL_ERROR_CODES = [
  /** Operands didn't satisfy the operator's type contract. */
  'type-mismatch',
  /** Field/index access on null or undefined target. */
  'null-access',
  /** Arithmetic produced NaN or Infinity, or `% 0`. */
  'division-by-zero',
  /** `$alias` referenced a name not in the captured read-set. */
  'unknown-reference',
  /** Sentinel value used outside its allowed slot (e.g. as operand). */
  'sentinel-misuse',
  /** Bracket index was a non-integer or negative. */
  'invalid-index',
] as const;

export type EvalErrorCode = typeof EVAL_ERROR_CODES[number];

export class EvalError extends Error {
  readonly code: EvalErrorCode;
  readonly pos: Position;
  constructor(code: EvalErrorCode, message: string, pos: Position) {
    super(message);
    this.name = 'EvalError';
    this.code = code;
    this.pos = pos;
  }
}

/**
 * Sentinel objects produced by the evaluator. Shape matches the
 * existing simulator's converters in
 * `simulator/converters/{fieldvalue,timestamp}.ts` — so the data tree
 * the walker builds is byte-compatible with what
 * `LocalEnvironment.transaction()` already accepts.
 */
export type SentinelValue =
  | { __type: 'serverTimestamp' }
  | { __type: 'increment'; value: number }
  | { __type: 'arrayUnion'; values: unknown[] }
  | { __type: 'arrayRemove'; values: unknown[] }
  | { __type: 'deleteField' };

/**
 * The runtime value an AST node evaluates to. Includes:
 *   - primitives: number, string, boolean, null
 *   - containers: arbitrary objects/arrays from `$alias` resolution
 *   - sentinels: top-level passthrough shapes
 *
 * NOTE: a sentinel is a valid top-level result (the walker stores it
 * as the leaf value), but not a valid operand to any operator. The
 * evaluator's operator handlers explicitly reject sentinel operands.
 */
export type EvalValue =
  | number
  | string
  | boolean
  | null
  | SentinelValue
  | EvalObject
  | EvalArray;

export interface EvalObject {
  readonly [key: string]: unknown;
}
export type EvalArray = readonly unknown[];

/**
 * Read-set captured by the tool layer before invoking the evaluator.
 * `null` means the doc did not exist at read time. Absence of an
 * alias from the map is a *programming* error (typo) — the
 * evaluator throws `unknown-reference` if a `$typo` shows up.
 */
export interface EvalEnv {
  readonly reads: Readonly<Record<string, EvalObject | null>>;
}

/**
 * Type-guard: does this value match one of the five sentinel shapes?
 * Used by every operator to reject sentinel operands.
 *
 * Production Firestore discriminates sentinels by object identity
 * (instanceof FieldValue subclass), which doesn't survive JSON-RPC.
 * The simulator approximates that with a structural shape — but a
 * shape match alone (just `__type`) over-classifies any read doc that
 * happens to have a field named `__type`. Tightening to also require
 * the *exact* per-sentinel shape (correct extras, no foreign keys)
 * narrows the false-positive surface to the (vanishingly rare) case of
 * a doc whose entire shape coincides with a sentinel's.
 */
export function isSentinelValue(v: unknown): v is SentinelValue {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  const t = obj.__type;
  const keys = Object.keys(obj);
  switch (t) {
    case 'serverTimestamp':
    case 'deleteField':
      // Exactly { __type }.
      return keys.length === 1;
    case 'increment':
      // Exactly { __type, value: number }.
      return keys.length === 2 && typeof obj.value === 'number';
    case 'arrayUnion':
    case 'arrayRemove':
      // Exactly { __type, values: array }.
      return keys.length === 2 && Array.isArray(obj.values);
    default:
      return false;
  }
}

/**
 * Helper used by operator handlers to throw a uniform type-mismatch
 * error. Pulls out the AST node's position so the agent gets a
 * column pointer.
 */
export function typeMismatch(
  node: AstNode,
  message: string,
): EvalError {
  return new EvalError('type-mismatch', message, node.pos);
}
