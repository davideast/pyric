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
import { SDK_VERSION } from '../../app/diagnostics.js';
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

/** Where in a write a validation error points, as the SDK prints it: the
 *  path's segments joined with `.`, or nothing at the root
 *  (`validationPathToErrorString`). */
function propertyText(segments: readonly string[]): string {
  return segments.length === 0 ? '' : `in property '${segments.join('.')}'`;
}

/**
 * Validate a value against RTDB's write rules, throwing the SDK's error (a
 * plain `Error` with the same text) on the first violation. Mirrors
 * `validateFirebaseData` (`@firebase/database` 1.1.3): `undefined`, a
 * function, `NaN` or an infinity anywhere, an invalid key, or a `.value`
 * key beside real children. An array hole is skipped, as the SDK's `each`
 * skips it; an element that is explicitly `undefined` is not. `path` is the
 * path the value is written to, and `fnName` and `argName` name the call
 * (`set` and `value`, `push` and `value`, `update` and `values`).
 */
export function validateWrite(value: unknown, path: string, fnName = 'set', argName = 'value'): void {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  validateData(value, segments, `${fnName} failed: ${argName} argument `);
}

function validateData(value: unknown, segments: readonly string[], prefix: string): void {
  const where = propertyText(segments);
  if (value === undefined) {
    throw new Error(`${prefix}contains undefined ${where}`);
  }
  if (typeof value === 'function') {
    throw new Error(`${prefix}contains a function ${where} with contents = ${String(value)}`);
  }
  if (isInvalidJSONNumber(value)) {
    throw new Error(`${prefix}contains ${String(value)} ${where}`);
  }
  if (value === null || typeof value !== 'object') {
    return;
  }
  let hasDotValue = false;
  let hasActualChild = false;
  // Own enumerable keys, as the SDK's `each` walks them: an array hole is
  // not a key, so it is skipped.
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === '.value') {
      hasDotValue = true;
    } else if (key !== '.priority' && key !== '.sv') {
      hasActualChild = true;
      if (!isValidKey(key)) {
        throw new Error(
          `${prefix} contains an invalid key (${key}) ${where}.  Keys must be non-empty strings ` +
            'and can\'t contain ".", "#", "$", "/", "[", or "]"',
        );
      }
    }
    validateData(child, [...segments, key], prefix);
  }
  if (hasDotValue && hasActualChild) {
    throw new Error(`${prefix} contains ".value" child ${where} in addition to actual children.`);
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
export function normalizeWrite(value: unknown, pathPrefix: string, fnName = 'set', argName = 'value'): JsonValue {
  validateWrite(value, pathPrefix, fnName, argName);
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

  // Plain object → unwrap `.value` when present, strip `.priority` metadata,
  // and prune null children + empty subtrees.
  if (Object.hasOwn(value as object, '.value')) {
    return normalizeNode((value as Record<string, unknown>)['.value']);
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === '.priority') {
      continue;
    }
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

/** A `.priority` a write value carries, at its path relative to the value. */
export interface InlinePriority {
  segments: string[];
  priority: string | number | null;
}

/**
 * Every `.priority` key in a write value, at its path relative to the value
 * (`[]` for the value itself). The SDK reads these while it builds the
 * written node (`nodeFromJSON`), so a priority of any other type fails its
 * assertion with that text. A server-value priority is not modeled and is
 * left out.
 */
export function inlinePriorities(value: unknown): InlinePriority[] {
  const found: InlinePriority[] = [];
  const walk = (node: unknown, segments: string[]): void => {
    if (node === null || typeof node !== 'object') return;
    const isObject = !Array.isArray(node);
    if (isObject && Object.hasOwn(node, '.priority')) {
      const priority = (node as Record<string, unknown>)['.priority'];
      const isServerValue = typeof priority === 'object' && priority !== null && '.sv' in priority;
      if (priority !== null && typeof priority !== 'string' && typeof priority !== 'number' && !isServerValue) {
        throw new Error(`Firebase Database (${SDK_VERSION}) INTERNAL ASSERT FAILED: Invalid priority type found: ${typeof priority}`);
      }
      if (!isServerValue) found.push({ segments, priority: priority as string | number | null });
    }
    if (isObject && Object.hasOwn(node, '.value')) {
      walk((node as Record<string, unknown>)['.value'], segments);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('.')) continue;
      walk(child, [...segments, key]);
    }
  };
  walk(value, []);
  return found;
}

/**
 * The priority a write gives its target: the value's own `.priority` when it
 * carries one, which the SDK lets override the priority argument, else the
 * argument. `nested` holds the priorities below the target.
 */
export function writePriority(value: unknown, argument: string | number | null): {
  priority: string | number | null;
  inline: boolean;
  nested: InlinePriority[];
} {
  const all = inlinePriorities(value);
  const own = all.find((entry) => entry.segments.length === 0);
  return {
    priority: own ? own.priority : argument,
    inline: own !== undefined,
    nested: all.filter((entry) => entry.segments.length > 0),
  };
}

function withOwnPriority(node: unknown, priority: string | number): unknown {
  if (typeof node === 'object' && node !== null && !Array.isArray(node)) return { ...node, '.priority': priority };
  return { '.value': node, '.priority': priority };
}

/**
 * The value as rules read it: each non-null priority in `entries` is written
 * back as a `.priority` key on its node, and a leaf with a priority becomes
 * `{ ".value", ".priority" }`, so `getPriority()` reports it. An entry whose
 * node is absent is skipped. The value is not modified.
 */
export function withPriorities(value: JsonValue, entries: readonly InlinePriority[]): JsonValue {
  const present = entries.filter((entry) => entry.priority !== null);
  if (present.length === 0 || value === null) return value;
  let root: unknown = structuredClone(value);
  for (const { segments, priority } of present) {
    if (segments.length === 0) {
      root = withOwnPriority(root, priority!);
      continue;
    }
    let parent: unknown = root;
    for (const segment of segments.slice(0, -1)) {
      const isNode = typeof parent === 'object' && parent !== null && !Object.hasOwn(parent, '.value');
      parent = isNode ? (parent as Record<string, unknown>)[segment] : undefined;
    }
    const last = segments[segments.length - 1]!;
    if (typeof parent !== 'object' || parent === null || !Object.hasOwn(parent, last)) continue;
    const container = parent as Record<string, unknown>;
    if (container[last] === null) continue;
    container[last] = withOwnPriority(container[last], priority!);
  }
  return root as JsonValue;
}

/**
 * Normalize a resolved write value into the shape RTDB security rules read
 * (`newData`), converting arrays to integer-keyed objects, pruning null and
 * empty nodes, and re-attaching inline `.priority` metadata on surviving nodes.
 */
export function normalizeRuleWrite(value: unknown, priority: string | number | null = null): JsonValue {
  const written = writePriority(value, priority);
  const normalized = normalizeNode(value);
  return withPriorities(normalized, [{ segments: [], priority: written.priority }, ...written.nested]);
}

/**
 * Read-side array coercion. RTDB renders an integer-keyed object back as
 * an array on `DataSnapshot.val()` when ALL keys are non-negative
 * integers AND the max key is `< 2 * numKeys` (a density heuristic that
 * avoids materializing a giant sparse array). Mirrors `ChildrenNode.val`
 * (`ChildrenNode.ts:196-230`). Recurses into children.
 *
 * Absent integer slots are array holes, as `ChildrenNode.val` leaves them.
 * A hole serializes to `null` in JSON, so a value that crosses the wire
 * reads back with `null` there.
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
    // `ChildrenNode.val` assigns only the keys present, so a missing index
    // is a hole, not a `null`.
    const arr: JsonValue[] = new Array<JsonValue>(maxKey + 1);
    for (const [key, child] of Object.entries(obj)) {
      arr[Number(key)] = coerceArrays(child);
    }
    return arr;
  }
  const out: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = coerceArrays(v);
  }
  return out;
}
