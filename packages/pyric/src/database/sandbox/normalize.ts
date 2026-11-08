/**
 * RTDB write-boundary normalization — the `nodeFromJSON`-equivalent.
 *
 * Production `firebase/database` runs every write through two upstream
 * stages before it lands in storage:
 *
 *   1. **Validation** (`core/util/validation.ts` `validateFirebaseData`):
 *      rejects `undefined` payloads, functions, non-finite numbers, and
 *      invalid keys (any key containing `.`, `#`, `$`, `/`, `[`, `]`, or
 *      a control char; empty-string keys). A data object silently
 *      un-writable to prod is a parity bug — we reject it here too.
 *
 *   2. **Normalization** (`core/snap/nodeFromJSON.ts` +
 *      `ChildrenNode.val`): collapses the JSON into RTDB's snapshot
 *      model, where:
 *        - Arrays are modeled as integer-keyed objects (`['a','b']` →
 *          `{ '0':'a', '1':'b' }`); sparse slots (holes / `undefined` /
 *          `null` elements) are dropped (upstream `each` skips them).
 *        - `null` children and empty objects are pruned — "empty nodes
 *          don't exist". An object that prunes to nothing becomes `null`
 *          (a delete).
 *
 * This module is the single boundary that closes DB-B1 (validation),
 * DB-B2 (array↔integer-keyed-object coercion), and DB-B3 (null/empty
 * pruning). The backend calls {@link normalizeWrite} on the resolved
 * (post-sentinel) value before handing it to {@link DataTree}.
 *
 * Read-side array coercion (the inverse — integer-keyed objects render
 * back as arrays on `val()`) lives in {@link coerceArrays} and
 * {@link asSdkArray}, mirroring
 * `ChildrenNode.val()`'s `allIntegerKeys && maxKey < 2 * numKeys` rule.
 *
 * Upstream references (clone @ 6a9d3d18):
 *   - `core/util/validation.ts:45,51,58,96-199`
 *   - `core/snap/nodeFromJSON.ts:40-132`
 *   - `core/snap/ChildrenNode.ts:194-230` (val array coercion)
 */
import { normalizeNode } from '../../rules/rtdb/data/normalize.js';
import { validateUpdatePaths } from '../writable-path.js';
import {
  errorPrefix,
  isInvalidJSONNumber,
  validateData,
  validateWrite,
} from '../../rules/rtdb/data/write-validation.js';
import { pathSegments, type JsonValue } from './data-tree.js';

export * from '../../rules/rtdb/data/normalize.js';
export { errorPrefix, validateWrite } from '../../rules/rtdb/data/write-validation.js';

/** The start of the SDK's error for a refused transaction result. */
export const TRANSACTION_ERROR_PREFIX = 'transaction failed: Data returned ';

const PRIORITY_RULE = 'must be a valid Firebase priority (a string, finite number, server value, or null).';

/** Whether the SDK accepts `value` as a priority: null, a string, a finite
 *  number, or a server value (`isValidPriority`). */
function isValidPriority(value: unknown): boolean {
  if (value === null || typeof value === 'string') return true;
  if (typeof value === 'number') return !isInvalidJSONNumber(value);
  return typeof value === 'object' && Object.hasOwn(value, '.sv');
}

export function validatePriorityArg(fnName: string, priority: unknown): void {
  const prefix = errorPrefix(fnName, 'priority');
  if (isInvalidJSONNumber(priority)) {
    throw new Error(`${prefix}is ${String(priority)}, but ${PRIORITY_RULE}`);
  }
  if (!isValidPriority(priority)) {
    throw new Error(`${prefix}${PRIORITY_RULE}`);
  }
}

/**
 * Validate `update()` values as the SDK does before sending them
 * (`validateFirebaseMergeDataArg`): an object, each value valid at its path,
 * a valid priority under each key ending in `.priority`, then valid and
 * non-overlapping keys. Returns the values.
 */
export function validateUpdate(values: unknown, path: string, fnName = 'update'): Record<string, unknown> {
  const prefix = errorPrefix(fnName, 'values');
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error(`${prefix} must be an object containing the children to replace.`);
  }
  const patch = values as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    const keySegments = pathSegments(key);
    validateData(value, [...pathSegments(path), ...keySegments], prefix);
    const isPriorityKey = keySegments[keySegments.length - 1] === '.priority';
    if (isPriorityKey && !isValidPriority(value)) {
      throw new Error(
        `${prefix}contains an invalid value for '/${keySegments.join('/')}', which ${PRIORITY_RULE}`,
      );
    }
  }
  validateUpdatePaths(patch, pathSegments, fnName);
  return patch;
}

/**
 * Validate then normalize a resolved write value into RTDB's storage
 * shape. Returns the storable `JsonValue` (or `null` if the value prunes
 * to nothing — i.e. it's a delete). Mirrors `nodeFromJSON` collapse:
 *
 *   - arrays → integer-keyed objects, holes / null / undefined elements
 *     dropped;
 *   - `null` children dropped;
 *   - empty objects (after pruning) → `null`.
 *
 * Leaf primitives (string / number / boolean) pass through unchanged —
 * including at the root (DB-B13: `set(ref(db), 'hello')` is legal).
 */
export function normalizeWrite(value: unknown, pathPrefix: string, prefix = errorPrefix('set', 'value')): JsonValue {
  validateWrite(value, pathPrefix, prefix);
  return normalizeNode(value) as JsonValue;
}

/**
 * Read-side array coercion. RTDB renders an integer-keyed object back as
 * an array on `DataSnapshot.val()` when all keys are non-negative
 * integers and the max key is `< 2 * numKeys` (a density heuristic that
 * avoids materializing a giant sparse array). Mirrors `ChildrenNode.val`
 * (`ChildrenNode.ts:196-230`). Recurses into children.
 *
 * Only the indexes that hold a value are assigned, so a missing index is
 * an array hole, not `null`: upstream copies `array[key] = obj[key]` for
 * the present keys only (RT-6, #1371).
 */
export function coerceArrays(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    // Already an array (shouldn't occur in stored data, but be defensive).
    return value.map((v) => coerceArrays(v));
  }
  const out: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(value as Record<string, JsonValue>)) {
    out[k] = coerceArrays(v);
  }
  return asSdkArray(out) ?? out;
}

const INTEGER_KEY = /^(0|[1-9]\d*)$/;

/**
 * `children` as the array `val()` renders, or `null` when the SDK keeps
 * them an object: some key is not an integer, or the largest is not below
 * twice the key count. Children are copied as they are, without recursing.
 */
export function asSdkArray(children: Record<string, JsonValue>): JsonValue[] | null {
  const keys = Object.keys(children);
  if (keys.length === 0) return null;
  let maxKey = 0;
  for (const key of keys) {
    if (!INTEGER_KEY.test(key)) return null;
    maxKey = Math.max(maxKey, Number(key));
  }
  if (maxKey >= 2 * keys.length) return null;
  const array: JsonValue[] = [];
  for (const key of keys) array[Number(key)] = children[key];
  return array;
}
