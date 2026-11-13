/**
 * RTDB-shaped in-memory JSON tree.
 *
 * The data layer for the modular SDK's sandbox target. RTDB stores a
 * single nested JSON tree; reads name a path and walk; writes either
 * replace a subtree (`set`) or merge top-level keys (`update`).
 *
 * Path semantics (matches `firebase/database`):
 *   - `'/'` is the root.
 *   - Leading + trailing slashes are stripped; empty segments are
 *     ignored.
 *   - `null` at any level erases that subtree. Locked by oracle
 *     observation
 *     `packages/conformance/observations/rtdb/rtdb-remove-vs-set-null.json` which
 *     says `set(ref, null)` and `remove(ref)` produce equivalent end
 *     states.
 *   - A read of an absent path returns `null` (NOT an error). Matches
 *     the `DataSnapshot.val()` contract.
 *
 * Trimming: when a write or delete leaves a sibling-less empty branch,
 * the empty branch is removed. RTDB's documented invariant: "Empty
 * nodes don't exist". The crawl + listener layers count on this so
 * `exists()` and `hasChildren()` match prod.
 *
 * This module is identity-agnostic — rules evaluation happens in
 * `local-environment.ts`. The tree just stores bytes.
 */

import { jsonEqual } from '@pyric/rules/internal/rtdb';
import type { JsonValue } from '@pyric/rules/internal/rtdb';
import { pathSegments } from '@pyric/rules/internal/rtdb';

export { pathSegments };
export type { JsonValue };

/** Join segments back into a `/`-prefixed canonical path. `[]` → `'/'`. */
export function joinPath(segments: string[]): string {
  if (segments.length === 0) return '/';
  return '/' + segments.join('/');
}

/** Get the parent path (one segment up). `'/'`'s parent is itself
 *  (matches `firebase/database`'s `ref.parent` returning `null` for root —
 *  the modular SDK's surface handles that translation; the tree
 *  doesn't). */
export function parentPath(path: string): string {
  const segs = pathSegments(path);
  if (segs.length === 0) return '/';
  return joinPath(segs.slice(0, -1));
}

/** Last segment of a path. `'/'` → ''. Matches `DatabaseReference.key`. */
export function lastSegment(path: string): string {
  const segs = pathSegments(path);
  return segs[segs.length - 1] ?? '';
}

export function setOwnProperty<V>(target: Record<string, V>, key: string, value: V): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    target[key] = value;
  }
}

/** Deep-clone a JSON value. Used to keep stored state from sharing
 *  identity with caller-held references (so mutating the returned
 *  value doesn't corrupt storage). */
export function cloneJson<T extends JsonValue>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => cloneJson(x as JsonValue)) as T;
  const out: Record<string, JsonValue> = {};
  for (const [k, val] of Object.entries(v as Record<string, JsonValue>)) {
    setOwnProperty(out, k, cloneJson(val));
  }
  return out as T;
}

const EMPTY_FROZEN_OBJECT: Record<string, JsonValue> = Object.freeze({});

/** Deep-clone and freeze a JSON value for persistent copy-on-write tree storage. */
function cloneFrozenJson<T extends JsonValue>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    return Object.freeze(v.map((x) => cloneFrozenJson(x as JsonValue))) as T;
  }
  const entries = Object.entries(v as Record<string, JsonValue>);
  if (entries.length === 0) return EMPTY_FROZEN_OBJECT as T;
  const out: Record<string, JsonValue> = {};
  for (const [k, val] of entries) {
    setOwnProperty(out, k, cloneFrozenJson(val));
  }
  return Object.freeze(out) as T;
}

function writeFrozenAt(
  parent: Record<string, JsonValue>,
  segs: readonly string[],
  idx: number,
  value: JsonValue,
): Record<string, JsonValue> | null {
  const targetKey = segs[idx]!;
  let nextChild: JsonValue | null;
  if (idx === segs.length - 1) {
    nextChild = value === null ? null : cloneFrozenJson(value);
  } else {
    const existing = Object.hasOwn(parent, targetKey) ? parent[targetKey] : undefined;
    const childObj =
      existing !== undefined && existing !== null && typeof existing === 'object' && !Array.isArray(existing)
        ? (existing as Record<string, JsonValue>)
        : EMPTY_FROZEN_OBJECT;
    nextChild = writeFrozenAt(childObj, segs, idx + 1, value);
  }

  if (nextChild === null) {
    if (!Object.hasOwn(parent, targetKey)) {
      return Object.keys(parent).length === 0 ? null : parent;
    }
    const out: Record<string, JsonValue> = {};
    let count = 0;
    for (const [k, v] of Object.entries(parent)) {
      if (k === targetKey) continue;
      setOwnProperty(out, k, v);
      count += 1;
    }
    return count === 0 ? null : Object.freeze(out);
  }

  const out: Record<string, JsonValue> = {};
  let wrote = false;
  for (const [k, v] of Object.entries(parent)) {
    setOwnProperty(out, k, k === targetKey ? nextChild : v);
    if (k === targetKey) wrote = true;
  }
  if (!wrote) {
    setOwnProperty(out, targetKey, nextChild);
  }
  return Object.freeze(out);
}

/** True for RTDB JSON object nodes. Arrays are ordered values in RTDB,
 *  not object patches or path maps. */
export function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural RTDB JSON equality: the rules engine's {@link jsonEqual}.
 *
 * Object key order is ignored, array order is preserved, keys are own
 * keys (an own `__proto__` is an ordinary key), and numbers compare with
 * `===`, so `-0` equals `0` as it does once JSON carries it. RTDB listener
 * diffs and fixture replay use it to decide whether two states are the same.
 */
export const jsonValuesEqual = jsonEqual;

/**
 * In-memory JSON tree. One instance per sandbox.
 *
 * The internal representation is a single mutable JSON object hung off
 * `root`. Writes use the path to walk + mutate; reads use the path to
 * walk + extract.
 *
 * Concurrency: single-threaded JS — every method is synchronous and
 * runs to completion before any other op observes the tree. Matches the
 * `firebase/database` modular SDK's local-cache semantics.
 */
export class DataTree {
  // Root is usually a keyed object, but RTDB also permits a primitive
  // (or array, coerced upstream) at the root (DB-B13:
  // `set(ref(db), 'hello')` is legal in prod).
  // Stored nodes are persistent (copy-on-write spine) and deeply frozen so
  // read-only consumers (such as rules evaluation) can neither mutate storage
  // nor observe post-write mutations through a previously captured reference.
  private root: JsonValue = EMPTY_FROZEN_OBJECT;
  private _generation = 0;

  /** Monotonic counter incremented on every tree mutation or restore. */
  get generation(): number {
    return this._generation;
  }

  /**
   * Internal read-only view of the root node without cloning. Callers must
   * never mutate the returned object or expose it directly to user code.
   */
  peekRoot(): JsonValue {
    return this.root;
  }

  /**
   * Internal read-only lookup at `segs` without cloning, preserving exact
   * stored node shapes (including empty objects restored verbatim).
   */
  peekSegments(segs: readonly string[]): JsonValue | undefined {
    if (segs.length === 0) return this.root;
    let node: JsonValue = this.root;
    for (const seg of segs) {
      if (node === null || typeof node !== 'object' || Array.isArray(node)) {
        return undefined;
      }
      const obj = node as { [key: string]: JsonValue };
      if (!Object.hasOwn(obj, seg)) return undefined;
      node = obj[seg]!;
    }
    return node;
  }

  /** Snapshot — defensive deep-copy of the full tree. Returns the root
   *  value; usually an object, but may be a primitive (DB-B13). */
  snapshot(): JsonValue {
    return cloneJson(this.root);
  }

  /** Restore — overwrite the tree with the given root. */
  restore(root: JsonValue): void {
    this._generation += 1;
    this.root = cloneFrozenJson(root);
  }

  /**
   * Read the value at `path`. Returns `null` if the path is absent —
   * the SDK's `DataSnapshot.val()` contract.
   *
   * The returned value is a defensive copy; callers can hold + mutate
   * it without disturbing storage.
   */
  read(path: string): JsonValue {
    const segs = pathSegments(path);
    const isInfoSystemPath = segs.length > 0 && segs[0] === '.info';
    if (isInfoSystemPath) {
      if (segs.length === 1) return { connected: true, serverTimeOffset: 0 };
      if (segs[1] === 'connected') return true;
      if (segs[1] === 'serverTimeOffset') return 0;
      return null;
    }
    let node: JsonValue = this.root;
    for (const seg of segs) {
      if (node === null || typeof node !== 'object' || Array.isArray(node)) {
        return null;
      }
      const obj = node as { [key: string]: JsonValue };
      // Own-property check only: `seg in obj` would follow inherited keys
      // (e.g. an unvalidated `__proto__`) into the object prototype.
      if (!Object.hasOwn(obj, seg)) return null;
      node = obj[seg]!;
    }
    // A node with no children holds no value. Deletes trim empty objects
    // below the root, but the root itself is stored as `{}` when empty.
    if (isJsonObject(node) && Object.keys(node).length === 0) return null;
    return cloneJson(node);
  }

  /**
   * Write `value` at `path`, replacing whatever was there. Passing
   * `null` deletes the path. The set is total — children of the prior
   * value at `path` are gone, regardless of their own shape.
   *
   * Returns the prior value at `path` (for undo / event-log).
   */
  write(path: string, value: JsonValue): JsonValue {
    this._generation += 1;
    const segs = pathSegments(path);
    const prior = this.read(path);
    if (segs.length === 0) {
      // Root write. `null` clears; otherwise replace the whole tree.
      // A primitive at the root is legal (DB-B13:
      // `set(ref(db), 'hello')`). Arrays are coerced to integer-keyed
      // objects upstream by the write-boundary normalizer.
      this.root = value === null ? EMPTY_FROZEN_OBJECT : cloneFrozenJson(value);
      return prior;
    }
    // A non-root write into a tree whose root is a primitive replaces the
    // root with a fresh object — "writes win" (the primitive is gone).
    const baseRoot =
      this.root !== null && typeof this.root === 'object' && !Array.isArray(this.root)
        ? (this.root as Record<string, JsonValue>)
        : EMPTY_FROZEN_OBJECT;
    this.root = writeFrozenAt(baseRoot, segs, 0, value) ?? EMPTY_FROZEN_OBJECT;
    return prior;
  }

  /**
   * Multi-path atomic update — replaces every listed path. Used by the
   * modular SDK's `update(rootRef, { '/a': v1, '/b': v2 })` fan-out.
   *
   * Validation: paths must be syntactically valid (no double-slash
   * after normalisation; no overlap where one is a prefix of another).
   * On overlap the entire update rejects — matches the production
   * SDK's invariant. The caller (LocalEnvironment) is responsible for
   * gating writes through the rules engine before reaching here; this
   * method assumes the rule check already passed for every path.
   */
  multiUpdate(updates: Record<string, JsonValue>): Array<{ path: string; prior: JsonValue }> {
    const entries = Object.entries(updates);
    const normalised = entries.map(([p, v]) => ({ path: joinPath(pathSegments(p)), value: v }));
    // Overlap check.
    for (let i = 0; i < normalised.length; i++) {
      for (let j = i + 1; j < normalised.length; j++) {
        const a = normalised[i]!.path;
        const b = normalised[j]!.path;
        if (a === b) {
          throw new Error(`multi-path update: duplicate path '${a}'.`);
        }
        const ap = a === '/' ? '/' : a + '/';
        const bp = b === '/' ? '/' : b + '/';
        if (a !== '/' && b.startsWith(ap)) {
          throw new Error(`multi-path update: '${b}' is a descendant of '${a}'.`);
        }
        if (b !== '/' && a.startsWith(bp)) {
          throw new Error(`multi-path update: '${a}' is a descendant of '${b}'.`);
        }
      }
    }
    const trace: Array<{ path: string; prior: JsonValue }> = [];
    for (const { path, value } of normalised) {
      const prior = this.write(path, value);
      trace.push({ path, prior });
    }
    return trace;
  }

  /**
   * Update merge at `path` — replaces top-level keys of an object at
   * `path` with the supplied entries. NOT multi-path (use
   * `multiUpdate` for that). A key whose value is `null` removes that
   * key from storage.
   *
   * Returns the prior values at each merged sub-path so the caller can
   * build a write event.
   */
  shallowUpdate(path: string, patch: Record<string, JsonValue>): Array<{ path: string; prior: JsonValue }> {
    const trace: Array<{ path: string; prior: JsonValue }> = [];
    const base = pathSegments(path);
    for (const [k, v] of Object.entries(patch)) {
      const segs = [...base, ...pathSegments(k)];
      const sub = joinPath(segs);
      const prior = this.write(sub, v);
      trace.push({ path: sub, prior });
    }
    return trace;
  }
}
