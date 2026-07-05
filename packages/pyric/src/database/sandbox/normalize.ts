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
 * back as arrays on `val()`) lives in {@link coerceArrays}, mirroring
 * `ChildrenNode.val()`'s `allIntegerKeys && maxKey < 2 * numKeys` rule.
 *
 * Upstream references (clone @ 6a9d3d18):
 *   - `core/util/validation.ts:45,51,58,96-199`
 *   - `core/snap/nodeFromJSON.ts:40-132`
 *   - `core/snap/ChildrenNode.ts:194-230` (val array coercion)
 */
import type { JsonValue } from './data-tree.js';

/** True for invalid Firebase keys. Mirrors `INVALID_KEY_REGEX_`
 *  (`validation.ts:45`): `.`, `#`, `$`, `/`, `[`, `]`, control chars. */
const INVALID_KEY_REGEX = /[\[\].#$/\u0000-\u001F\u007F]/;

/** A valid Firebase key — non-empty string, no forbidden chars. Mirrors
 *  `isValidKey` (`validation.ts:58`). The `.priority` / `.value` / `.sv`
 *  metadata keys are handled by the caller before this check. */
function isValidKey(key: string): boolean {
  return key.length !== 0 && !INVALID_KEY_REGEX.test(key);
}

/** True for a number RTDB rejects (NaN / ±Infinity). Mirrors
 *  `isInvalidJSONNumber` (`util.ts`). */
function isInvalidJSONNumber(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    (Number.isNaN(value) || value === Infinity || value === -Infinity)
  );
}

/** The metadata keys RTDB exempts from key validation. */
function isMetadataKey(key: string): boolean {
  return key === '.priority' || key === '.value' || key === '.sv';
}

/**
 * Validate a value against RTDB's write rules, throwing the upstream
 * error shape (a plain `Error`) on the first violation. Mirrors
 * `validateFirebaseData` (`validation.ts:112-199`). `pathPrefix` is the
 * absolute path the value is being written to — used for a prod-shaped
 * error message.
 */
export function validateWrite(value: unknown, pathPrefix: string): void {
  validateData(value, pathPrefix, 'set');
}

function validateData(value: unknown, path: string, fnName: string): void {
  if (value === undefined) {
    throw new Error(`${fnName} failed: value argument contains undefined in property '${path}'`);
  }
  if (typeof value === 'function') {
    throw new Error(`${fnName} failed: value argument contains a function in property '${path}'`);
  }
  if (isInvalidJSONNumber(value)) {
    throw new Error(`${fnName} failed: value argument contains ${String(value)} in property '${path}'`);
  }
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    // Arrays validate per-element. Holes (`undefined`) are skipped (they
    // become absent integer keys), matching `each` over a sparse array.
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) continue;
      const el = value[i];
      if (el === undefined) continue;
      validateData(el, `${path}/${i}`, fnName);
    }
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (!isMetadataKey(key) && !isValidKey(key)) {
      throw new Error(
        `${fnName} failed: value argument contains an invalid key (${key}) in path ${path}. ` +
          'Keys must be non-empty strings and can\'t contain ".", "#", "$", "/", "[", or "]"',
      );
    }
    validateData(child, `${path}/${key}`, fnName);
  }
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
export function normalizeWrite(value: unknown, pathPrefix: string): JsonValue {
  validateWrite(value, pathPrefix);
  return normalizeNode(value) as JsonValue;
}

/**
 * Normalize a validated value into storage shape. No validation here —
 * call {@link validateWrite} first (or use {@link normalizeWrite}).
 * Returns `null` for a value that prunes away.
 */
export function normalizeNode(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value as JsonValue;

  // Array → integer-keyed object. Holes / null / undefined elements are
  // dropped (upstream `each` over an array skips them).
  if (Array.isArray(value)) {
    const out: Record<string, JsonValue> = {};
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) continue;
      const child = normalizeNode(value[i]);
      if (child === null) continue;
      out[String(i)] = child;
    }
    return Object.keys(out).length === 0 ? null : out;
  }

  // Plain object → prune null children + empty subtrees.
  const out: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === '.sv') {
      // Server-value wrapper that survived (shouldn't normally reach
      // here post-sentinel-resolution) — keep verbatim.
      out[key] = child as JsonValue;
      continue;
    }
    const normalized = normalizeNode(child);
    if (normalized === null) continue;
    out[key] = normalized;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * Read-side array coercion. RTDB renders an integer-keyed object back as
 * an array on `DataSnapshot.val()` when ALL keys are non-negative
 * integers AND the max key is `< 2 * numKeys` (a density heuristic that
 * avoids materializing a giant sparse array). Mirrors `ChildrenNode.val`
 * (`ChildrenNode.ts:196-230`). Recurses into children.
 *
 * Absent integer slots become array holes filled with `null` (matching
 * prod, where a coerced array's missing indices read back as `null`).
 */
export function coerceArrays(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    // Already an array (shouldn't occur in stored data, but be defensive).
    return value.map((v) => coerceArrays(v));
  }
  const obj = value as Record<string, JsonValue>;
  const keys = Object.keys(obj);
  let allIntegerKeys = keys.length > 0;
  let maxKey = 0;
  for (const k of keys) {
    if (/^(0|[1-9]\d*)$/.test(k)) {
      maxKey = Math.max(maxKey, Number(k));
    } else {
      allIntegerKeys = false;
      break;
    }
  }
  if (allIntegerKeys && maxKey < 2 * keys.length) {
    const arr: JsonValue[] = [];
    for (let i = 0; i <= maxKey; i++) {
      const child = obj[String(i)];
      arr[i] = child === undefined ? null : coerceArrays(child);
    }
    return arr;
  }
  const out: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = coerceArrays(v);
  }
  return out;
}
