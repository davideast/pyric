/**
 * RTDB write-boundary normalization -- the `nodeFromJSON`-equivalent.
 *
 * Production `firebase/database` runs every write through two upstream
 * stages before it lands in storage:
 *
 *   1. **Validation** (`core/util/validation.ts` `validateFirebaseData`):
 *      rejects `undefined` payloads, functions, non-finite numbers, and
 *      invalid keys (any key containing `.`, `#`, `$`, `/`, `[`, `]`, or
 *      a control char; empty-string keys). A data object silently
 *      un-writable to prod is a parity bug -- we reject it here too.
 *
 *   2. **Normalization** (`core/snap/nodeFromJSON.ts` +
 *      `ChildrenNode.val`): collapses the JSON into RTDB's snapshot
 *      model, where:
 *        - Arrays are modeled as integer-keyed objects (`['a','b']` ->
 *          `{ '0':'a', '1':'b' }`); sparse slots (holes / `undefined` /
 *          `null` elements) are dropped (upstream `each` skips them).
 *        - `null` children and empty objects are pruned -- "empty nodes
 *          don't exist". An object that prunes to nothing becomes `null`
 *          (a delete).
 *
 * This module is the single boundary that closes DB-B1 (validation),
 * DB-B2 (array/integer-keyed-object coercion), and DB-B3 (null/empty
 * pruning). The backend calls {@link normalizeWrite} on the resolved
 * (post-sentinel) value before handing it to {@link DataTree}.
 *
 * Read-side array coercion (the inverse -- integer-keyed objects render
 * back as arrays on `val()`) lives in {@link coerceArrays} and
 * {@link asSdkArray}, mirroring
 * `ChildrenNode.val()`'s `allIntegerKeys && maxKey < 2 * numKeys` rule.
 */
import {
  errorPrefix,
  isInvalidJSONNumber,
  normalizeNode,
  validateData,
  validateWrite as validateRuleWrite,
} from '@pyric/rules/internal/rtdb';
import { validateUpdatePaths } from '../writable-path.js';
import { isReservedSegment, pathSegments, type JsonValue } from './data-tree.js';

export { normalizeNode, inlinePriorities, writePriority, withPriorities } from '@pyric/rules/internal/rtdb';
export type { InlinePriority } from '@pyric/rules/internal/rtdb';
export { errorPrefix } from '@pyric/rules/internal/rtdb';

/**
 * Matches `@firebase/util`'s `assertionError` prefix (`CONSTANTS.SDK_VERSION`
 * in modular `firebase` / `firebase-admin` is `'${JSCORE_VERSION}'`).
 */
const ASSERT_FAILED_PREFIX = 'Firebase Database (${JSCORE_VERSION}) INTERNAL ASSERT FAILED: ';
const INVALID_TRANSACTION_PRIORITY_ERROR =
  `${ASSERT_FAILED_PREFIX}Invalid priority returned by transaction. Priority must be a valid string, finite number, server value, or null.`;

interface WriteValidationOptions {
  readonly checkServerValues?: boolean;
  readonly checkInlinePriorities?: boolean;
}

/**
 * Reject reserved prototype-chain keys (`__proto__`, `prototype`, `constructor`)
 * anywhere inside a write payload before normalization, rules evaluation, or
 * listener fanout runs. Reuses `pathSegments` for the canonical error text so
 * writes cannot store keys that refs, queries, or snapshots cannot address.
 */
function assertNoReservedKeys(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (i in value) assertNoReservedKeys(value[i]);
    }
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === '.priority' || key === '.sv') continue;
    if (key !== '.value' && isReservedSegment(key)) {
      pathSegments(key);
    }
    assertNoReservedKeys(child);
  }
}

function assertValidServerValueObject(container: Record<string, unknown>): void {
  const op = container['.sv'];
  if (typeof op === 'string') {
    if (op !== 'timestamp') {
      throw new Error(`${ASSERT_FAILED_PREFIX}Unexpected server value: ${op}`);
    }
    return;
  }
  if (typeof op === 'object') {
    if (op === null) {
      (op as unknown as { hasOwnProperty: (key: string) => boolean }).hasOwnProperty('increment');
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(op, 'increment')) {
      throw new Error(`${ASSERT_FAILED_PREFIX}Unexpected server value: ${JSON.stringify(op, null, 2)}`);
    }
    const delta = (op as Record<string, unknown>).increment;
    if (typeof delta !== 'number') {
      throw new Error(`${ASSERT_FAILED_PREFIX}Unexpected increment value: ${String(delta)}`);
    }
    return;
  }
  throw new Error(`${ASSERT_FAILED_PREFIX}Unexpected server value: ${JSON.stringify(container, null, 2)}`);
}

/**
 * Validate every `{ '.sv': ... }` server-value marker in `value`, matching
 * `@firebase/database`'s `resolveDeferredLeafValue` (`ServerValues.ts`).
 */
function assertValidServerValues(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (i in value) assertValidServerValues(value[i]);
    }
    return;
  }
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, '.sv')) {
    assertValidServerValueObject(record);
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === '.sv') continue;
    assertValidServerValues(child);
  }
}

function assertValidInlinePriorities(value: unknown, skipRoot = false): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (i in value) assertValidInlinePriorities(value[i], false);
    }
    return;
  }
  const record = value as Record<string, unknown>;
  if (!skipRoot && Object.hasOwn(record, '.priority')) {
    const prio = record['.priority'];
    if (!isValidPriority(prio)) {
      throw new Error(`${ASSERT_FAILED_PREFIX}Invalid priority type found: ${typeof prio}`);
    }
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === '.priority' || key === '.sv') continue;
    assertValidInlinePriorities(child, false);
  }
}

export function validateWrite(
  value: unknown,
  path: string,
  prefix = errorPrefix('set', 'value'),
  options?: WriteValidationOptions,
): void {
  validateRuleWrite(value, path, prefix);
  assertNoReservedKeys(value);
  if (options?.checkInlinePriorities === true) {
    assertValidInlinePriorities(value, false);
  }
  if (options?.checkServerValues === true) {
    assertValidServerValues(value);
  }
}

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

export function validatePriorityArg(
  fnName: string,
  priority: unknown,
  options?: Pick<WriteValidationOptions, 'checkServerValues'>,
): void {
  const prefix = errorPrefix(fnName, 'priority');
  if (isInvalidJSONNumber(priority)) {
    throw new Error(`${prefix}is ${String(priority)}, but ${PRIORITY_RULE}`);
  }
  if (!isValidPriority(priority)) {
    throw new Error(`${prefix}${PRIORITY_RULE}`);
  }
  if (options?.checkServerValues === true) {
    assertValidServerValues(priority);
  }
}

export function validateTransactionCandidate(proposed: unknown, path: string): void {
  let normPath = path;
  if (path === '/') {
    normPath = '';
  }
  validateWrite(proposed, normPath, TRANSACTION_ERROR_PREFIX, {
    checkInlinePriorities: false,
    checkServerValues: false,
  });
  if (
    typeof proposed === 'object'
    && proposed !== null
    && !Array.isArray(proposed)
    && Object.hasOwn(proposed, '.priority')
  ) {
    const ownPrio = (proposed as Record<string, unknown>)['.priority'];
    if (!isValidPriority(ownPrio)) {
      throw new Error(INVALID_TRANSACTION_PRIORITY_ERROR);
    }
  }
  assertValidInlinePriorities(proposed, true);
  assertValidServerValues(proposed);
}

/**
 * Validate `update()` values as the SDK does before sending them
 * (`validateFirebaseMergeDataArg`): an object, each value valid at its path,
 * a valid priority under each key ending in `.priority`, then valid and
 * non-overlapping keys, followed by inline-priority and server-value checks.
 */
export function validateUpdate(
  values: unknown,
  path: string,
  fnName = 'update',
  options?: WriteValidationOptions,
): Record<string, unknown> {
  const prefix = errorPrefix(fnName, 'values');
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error(`${prefix} must be an object containing the children to replace.`);
  }
  const patch = values as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    const keySegments = pathSegments(key);
    validateData(value, [...pathSegments(path), ...keySegments], prefix);
    assertNoReservedKeys(value);
    const isPriorityKey = keySegments[keySegments.length - 1] === '.priority';
    if (isPriorityKey && !isValidPriority(value)) {
      throw new Error(
        `${prefix}contains an invalid value for '/${keySegments.join('/')}', which ${PRIORITY_RULE}`,
      );
    }
  }
  validateUpdatePaths(patch, pathSegments, fnName);
  if (options?.checkInlinePriorities === true) {
    for (const [key, value] of Object.entries(patch)) {
      const keySegments = pathSegments(key);
      if (keySegments[keySegments.length - 1] === '.priority') continue;
      assertValidInlinePriorities(value, false);
    }
  }
  if (options?.checkServerValues === true) {
    for (const value of Object.values(patch)) {
      assertValidServerValues(value);
    }
  }
  return patch;
}

/**
 * Validate then normalize a resolved write value into RTDB's storage
 * shape. Returns the storable `JsonValue` (or `null` if the value prunes
 * to nothing -- i.e. it's a delete). Mirrors `nodeFromJSON` collapse:
 *
 *   - arrays -> integer-keyed objects, holes / null / undefined elements
 *     dropped;
 *   - `null` children dropped;
 *   - empty objects (after pruning) -> `null`.
 *
 * Leaf primitives (string / number / boolean) pass through unchanged --
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
