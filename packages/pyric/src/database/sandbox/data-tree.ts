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

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Path segments that must never be walked or written: because the tree
 *  is backed by plain JS objects, a segment named `__proto__` (or, as
 *  defence-in-depth, `constructor`/`prototype`) would reach the shared
 *  `Object.prototype` and let a rule-permitted write pollute it
 *  process-wide. Real RTDB stores a server-side tree with no such
 *  reserved keys, so rejecting them is a sandbox-only safety constraint,
 *  not a parity regression. */
const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/** Normalise a path to an array of non-empty segments. `'/'` → [].
 *  Throws if any segment is a prototype-pollution vector. */
export function pathSegments(path: string): string[] {
  if (path === '' || path === '/') return [];
  // Strip leading + trailing slashes, then split on `/` and drop empties.
  const segs = path.split('/').filter((s) => s.length > 0);
  for (const seg of segs) {
    if (UNSAFE_SEGMENTS.has(seg)) {
      throw new Error(
        `Invalid RTDB path segment '${seg}': the keys __proto__, prototype, ` +
          'and constructor are reserved and cannot appear in a path.',
      );
    }
  }
  return segs;
}

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

/** Deep-clone a JSON value. Used to keep stored state from sharing
 *  identity with caller-held references (so mutating the returned
 *  value doesn't corrupt storage). */
export function cloneJson<T extends JsonValue>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => cloneJson(x as JsonValue)) as T;
  const out: Record<string, JsonValue> = {};
  for (const [k, val] of Object.entries(v as Record<string, JsonValue>)) {
    out[k] = cloneJson(val);
  }
  return out as T;
}

/** True for RTDB JSON object nodes. Arrays are ordered values in RTDB,
 *  not object patches or path maps. */
export function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural RTDB JSON equality.
 *
 * Object key order is ignored, array order is preserved, and primitive
 * leaves compare by value. This is the equality RTDB listener diffs and
 * fixture replay use when deciding whether two JSON states are the same.
 */
export function jsonValuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((value, index) => jsonValuesEqual(value, b[index]));
  }
  if (!isJsonObject(a) || !isJsonObject(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => key in b && jsonValuesEqual(a[key], b[key]));
}

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
  private root: JsonValue = {};

  /** Snapshot — defensive deep-copy of the full tree. Returns the root
   *  value; usually an object, but may be a primitive (DB-B13). */
  snapshot(): JsonValue {
    return cloneJson(this.root);
  }

  /** Restore — overwrite the tree with the given root. */
  restore(root: JsonValue): void {
    this.root = cloneJson(root);
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
    const segs = pathSegments(path);
    const prior = this.read(path);
    if (segs.length === 0) {
      // Root write. `null` clears; otherwise replace the whole tree.
      // A primitive at the root is legal (DB-B13:
      // `set(ref(db), 'hello')`). Arrays are coerced to integer-keyed
      // objects upstream by the write-boundary normalizer.
      if (value === null) {
        this.root = {};
        return prior;
      }
      this.root = cloneJson(value);
      return prior;
    }
    // A non-root write into a tree whose root is a primitive replaces the
    // root with a fresh object — "writes win" (the primitive is gone).
    if (this.root === null || typeof this.root !== 'object' || Array.isArray(this.root)) {
      this.root = {};
    }
    // Walk to parent, creating intermediate objects as needed. If a
    // primitive sits at an intermediate path, it becomes an object —
    // RTDB's "writes win" semantics.
    let cursor: Record<string, JsonValue> = this.root as Record<string, JsonValue>;
    for (let i = 0; i < segs.length - 1; i++) {
      const k = segs[i]!;
      // Own-property read only: bare `cursor[k]` would resolve an
      // unvalidated `__proto__` segment to the shared object prototype.
      const next = Object.hasOwn(cursor, k) ? cursor[k] : undefined;
      if (next === undefined || next === null || typeof next !== 'object' || Array.isArray(next)) {
        const fresh: Record<string, JsonValue> = {};
        cursor[k] = fresh;
        cursor = fresh;
      } else {
        cursor = next as Record<string, JsonValue>;
      }
    }
    const lastKey = segs[segs.length - 1]!;
    if (value === null) {
      delete cursor[lastKey];
      // Trim now-empty parents up the chain. Only structural emptiness
      // counts (no keys); a primitive sibling at a parent keeps it alive.
      this.trim(segs);
    } else {
      cursor[lastKey] = cloneJson(value);
    }
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

  /** Internal: trim empty-object ancestors of `segs` after a delete. */
  private trim(segs: string[]): void {
    // Walk every ancestor from the deleted segment upward; remove any
    // that's now an empty object. Stop at the first non-empty ancestor.
    if (this.root === null || typeof this.root !== 'object' || Array.isArray(this.root)) {
      return;
    }
    for (let depth = segs.length - 1; depth >= 1; depth--) {
      const parentSegs = segs.slice(0, depth);
      const lastKey = segs[depth - 1]!;
      let parent: Record<string, JsonValue> = this.root as Record<string, JsonValue>;
      for (let i = 0; i < parentSegs.length - 1; i++) {
        const next = parent[parentSegs[i]!];
        if (next === undefined || next === null || typeof next !== 'object' || Array.isArray(next)) {
          return;
        }
        parent = next as Record<string, JsonValue>;
      }
      const child = parent[lastKey];
      if (child !== undefined && typeof child === 'object' && child !== null && !Array.isArray(child)) {
        const obj = child as Record<string, JsonValue>;
        if (Object.keys(obj).length === 0) {
          delete parent[lastKey];
          continue;
        }
      }
      return;
    }
  }
}
