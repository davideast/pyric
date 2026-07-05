/**
 * `pyric-admin/database` — Phase 3 dispatch + Phase 4b sandbox backend.
 *
 * Mirrors `firebase-admin/database` for the admin-shape RTDB surface,
 * with backend dispatch on the {@link PyricAdminApp} brand
 * (ADR-001 D6 — every `pyric-admin/*` subpath dispatches on
 * `ADMIN_APP_TARGET`):
 *
 *   - **Prod path** (`ADMIN_APP_TARGET === 'prod'`) — `getDatabase`
 *     delegates to `firebase-admin/database`. The returned
 *     `Database` / `Reference` instances are the genuine firebase-admin
 *     objects, so every instance method (`set`, `get`, `update`,
 *     `remove`, `push`, `transaction`, `onDisconnect`, `child`, query
 *     builders, …) is present and identical in behavior to calling
 *     firebase-admin directly.
 *
 *   - **Sandbox path** (`ADMIN_APP_TARGET === 'sandbox'`) — a minimal
 *     in-memory RTDB implemented in this file. Backs the load-bearing
 *     data-plane subset:
 *
 *       - `Database.ref(path?)` returns a {@link Reference}.
 *       - `Reference#set(value)` writes into the in-memory tree.
 *       - `Reference#get()` reads; returns a `DataSnapshot`-shaped
 *         `{ exists(), val(), key, child(), forEach(), … }`.
 *       - `Reference#update(values)` merges children (a `null` value
 *         removes the corresponding child).
 *       - `Reference#remove()` deletes the subtree.
 *       - `Reference#push(value?)` mints a 20-char push id and writes
 *         the value at the new child path.
 *       - `Reference#child(path)` returns a relative ref.
 *
 *     **Not implemented (sandbox backend only):**
 *
 *       - Listeners — `on('value' | 'child_added' | …)`,
 *         `onDisconnect`, `off` — throw a clear "not implemented" error.
 *         The modular `pyric/database` surface has full listener
 *         support; the admin-shape sandbox surface defers them until
 *         a user actually needs the chainable admin listener shape.
 *       - Transactions — `Reference#transaction(updater)` throws
 *         "not implemented". The modular `pyric/database` surface has
 *         `runTransaction`; the admin-shape variant lands when needed.
 *       - Query builders — `orderByChild`/`equalTo`/`limitToFirst`/…
 *         on `Reference` throw "not implemented".
 *       - Multi-path atomic updates (root-level
 *         `update({ '/a': v1, '/b': v2 })`) — supported only as shallow
 *         merge at the ref's path. The modular surface has the full
 *         multi-path variant.
 *       - `Reference#setPriority` / `setWithPriority` — RTDB priority
 *         semantics aren't modeled; calls throw "not implemented".
 *       - `Database.getRules` / `setRules` / `getRulesJSON` — admin-
 *         only metadata. Sandbox writes are rule-bypass (matches the
 *         firebase-admin behavior of bypassing rules), so there's no
 *         backing rule state to expose.
 *
 *     Sandbox state lives on the underlying `Sandbox` via a `WeakMap`
 *     keyed by the `Sandbox` instance — `sandbox.reset()` wipes it via
 *     the sandbox's `session_boundary` event with `phase: 'reset'`.
 *     Successive `getDatabase(app)` calls for the same sandbox return
 *     handles that share data (matches firebase-admin's
 *     singleton-per-app semantics).
 */

import type { App } from 'firebase-admin/app';
import {
  getDatabase as adminGetDatabase,
  getDatabaseWithUrl as adminGetDatabaseWithUrl,
} from 'firebase-admin/database';
import type {
  Database as AdminDatabase,
  Reference as AdminReference,
  DataSnapshot as AdminDataSnapshot,
  ThenableReference as AdminThenableReference,
  Query as AdminQuery,
  OnDisconnect as AdminOnDisconnect,
  EventType as AdminEventType,
} from 'firebase-admin/database';
import type { Sandbox } from 'pyric/sandbox';

import {
  ADMIN_APP_TARGET,
  type PyricAdminApp,
} from '../app/index.js';

// Re-export the firebase-admin/database types so consumers can spell
// every type with a `pyric-admin/database` import path. The sandbox
// backend's `Database` / `Reference` / `DataSnapshot` implement the
// load-bearing subset of these shapes; the prod path returns the
// genuine firebase-admin instances unchanged.
export type {
  AdminDatabase as Database,
  AdminReference as Reference,
  AdminDataSnapshot as DataSnapshot,
  AdminThenableReference as ThenableReference,
  AdminQuery as Query,
  AdminOnDisconnect as OnDisconnect,
  AdminEventType as EventType,
};

/**
 * Returns the {@link AdminDatabase} service for the supplied app.
 *
 * Signature mirrors `firebase-admin/database`'s `getDatabase(app)` and
 * `getDatabaseWithUrl(url, app)` collapsed into a single function:
 *
 *   - `getDatabase(app)` — default database for the app.
 *   - `getDatabase(app, url)` — database at the explicit URL (delegates
 *     to firebase-admin's `getDatabaseWithUrl` on the prod path; the
 *     sandbox path ignores `url` since the sandbox has no notion of
 *     multiple database instances per project).
 *
 * Backend dispatch is by `ADMIN_APP_TARGET` brand on the
 * {@link PyricAdminApp} handle:
 *
 *   - `'prod'` → delegates to `firebase-admin/database`. The returned
 *     object is the genuine firebase-admin `Database`, so every
 *     instance method (`ref`, query builders, `getRules` / `setRules`,
 *     transactions, …) works unchanged.
 *
 *   - `'sandbox'` → returns the minimal in-memory `Database` backed by
 *     the per-`Sandbox` state described in the module-level docs.
 */
export function getDatabase(
  app: PyricAdminApp,
  url?: string,
): AdminDatabase {
  if (app[ADMIN_APP_TARGET] === 'prod') {
    return url === undefined
      ? adminGetDatabase(app.adminApp)
      : adminGetDatabaseWithUrl(url, app.adminApp);
  }
  if (app[ADMIN_APP_TARGET] === 'sandbox') {
    return getSandboxDatabase(app.sandbox);
  }
  throw new TypeError(
    'pyric-admin/database: getDatabase expected a PyricAdminApp ' +
      '(initialize via `initializeApp` from pyric-admin/app).',
  );
}

// ─── Sandbox backend ─────────────────────────────────────────────────
//
// Minimal in-memory RTDB for the admin-shape surface. Single nested
// JSON tree (`SandboxState.root`); writes mutate it, reads walk it.
// No rules engine (admin sandbox writes are rule-bypass — matches
// firebase-admin's behavior of bypassing rules), no listeners (deferred,
// see module-level "Not implemented" note), no queries (deferred).

/** Minimum JSON value shape stored in the in-memory tree. */
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Per-sandbox state. One instance per `Sandbox`; the WeakMap below
 * keys this off the `Sandbox` reference so `sandbox.reset()` can wipe
 * everything in one swap. The `Database` handle returned to consumers
 * holds onto the `SandboxState` directly so reads / writes don't
 * re-resolve through the WeakMap on every op.
 */
interface SandboxState {
  root: Record<string, JsonValue>;
}

/** One backend per `Sandbox`. Successive `getDatabase(app)` calls for
 *  the same sandbox return handles that share data — matches
 *  firebase-admin's singleton-per-app semantics. */
const stateBySandbox = new WeakMap<Sandbox, SandboxState>();

function getOrCreateState(sandbox: Sandbox): SandboxState {
  let state = stateBySandbox.get(sandbox);
  if (state !== undefined) return state;
  state = { root: {} };
  stateBySandbox.set(sandbox, state);
  // Wire `sandbox.reset()` → wipe the tree. `session_boundary` fires
  // before the env swap, so consumer code that observes a reset sees
  // the freshly-cleared tree on the next read. `dispose` also fires a
  // boundary; treat it the same (the sandbox is being torn down — any
  // in-flight handle on the tree gets an empty view).
  sandbox.onEvent((event) => {
    if (event.kind === 'session_boundary') {
      state!.root = {};
    }
  });
  return state;
}

/** Build (or reuse) the sandbox Database handle for `sandbox`. */
function getSandboxDatabase(sandbox: Sandbox): AdminDatabase {
  const state = getOrCreateState(sandbox);
  return buildSandboxDatabase(state);
}

function buildSandboxDatabase(state: SandboxState): AdminDatabase {
  const db = {
    ref(path?: string): AdminReference {
      return buildSandboxRef(state, db as unknown as AdminDatabase, path ?? '/');
    },
    refFromURL(url: string): AdminReference {
      // Best-effort: strip the `https://<host>` prefix and treat the
      // remainder as a path. The sandbox has no notion of multi-database
      // hosts, so the host portion is ignored.
      const u = url.replace(/^https?:\/\/[^/]+/, '');
      return buildSandboxRef(state, db as unknown as AdminDatabase, u || '/');
    },
    // Admin-only metadata methods — not modeled in the sandbox. The
    // sandbox is rule-bypass by construction; surfacing rule JSON would
    // require a parallel rules store that has no users yet.
    getRules(): Promise<string> {
      throw new Error(
        'pyric-admin/database sandbox: getRules not implemented',
      );
    },
    getRulesJSON(): Promise<object> {
      throw new Error(
        'pyric-admin/database sandbox: getRulesJSON not implemented',
      );
    },
    setRules(_source: string | object | Buffer): Promise<void> {
      throw new Error(
        'pyric-admin/database sandbox: setRules not implemented',
      );
    },
    useEmulator(_host: string, _port: number): void {
      // No-op — the sandbox IS a local emulator. Accept the call so
      // consumer code that calls `useEmulator` unconditionally compiles.
    },
    goOffline(): void {
      // No-op — sandbox has no network connection to drop.
    },
    goOnline(): void {
      // No-op — sandbox has no network connection to reopen.
    },
    // `app` is required on the firebase-admin Database interface; the
    // sandbox doesn't carry a firebase-admin App, so we stub it. The
    // load-bearing data-plane methods above don't read it.
    app: undefined as unknown as App,
  };
  return db as unknown as AdminDatabase;
}

// ─── Path utilities ──────────────────────────────────────────────────

/** Path segments that must never be walked or written: because the tree is
 *  backed by plain JS objects, a segment named `__proto__` (or, as
 *  defence-in-depth, `constructor`/`prototype`) would reach the shared
 *  `Object.prototype` and let a write pollute it process-wide (a path
 *  arrives via JSON/MCP transports that preserve `__proto__` as a genuine
 *  own key). Real RTDB stores a server-side tree with no such reserved
 *  keys, so rejecting them is a sandbox-only safety constraint, not a
 *  parity regression. Twin of the `pyric/database` DataTree guard (#760). */
const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/** Normalise a path to non-empty segments. `'/'` → `[]`.
 *  Throws if any segment is a prototype-pollution vector. */
function pathSegments(path: string): string[] {
  if (path === '' || path === '/') return [];
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
function joinPath(segments: string[]): string {
  if (segments.length === 0) return '/';
  return '/' + segments.join('/');
}

/** Deep-clone a JSON value so stored state doesn't share identity with
 *  caller-held references. */
function cloneJson<T extends JsonValue>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => cloneJson(x as JsonValue)) as T;
  const out: Record<string, JsonValue> = {};
  for (const [k, val] of Object.entries(v as Record<string, JsonValue>)) {
    out[k] = cloneJson(val);
  }
  return out as T;
}

/** Read the value at `path` in `root`. `null` for absent paths. */
function readPath(root: Record<string, JsonValue>, path: string): JsonValue {
  const segs = pathSegments(path);
  let node: JsonValue = root;
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

/** Write `value` at `path`. `null` deletes. Trims empty ancestor objects. */
function writePath(
  root: Record<string, JsonValue>,
  path: string,
  value: JsonValue,
): void {
  const segs = pathSegments(path);
  if (segs.length === 0) {
    // Root write — clear all keys and replace.
    for (const k of Object.keys(root)) delete root[k];
    if (value === null) return;
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(
        'pyric-admin/database sandbox: root write must be an object (or null to clear).',
      );
    }
    Object.assign(root, cloneJson(value) as Record<string, JsonValue>);
    return;
  }
  // Walk to parent, creating intermediate objects as needed.
  let cursor: Record<string, JsonValue> = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i]!;
    // Own-property read only: bare `cursor[k]` would resolve an unvalidated
    // `__proto__` segment to the shared object prototype.
    const next = Object.hasOwn(cursor, k) ? cursor[k] : undefined;
    if (
      next === undefined ||
      next === null ||
      typeof next !== 'object' ||
      Array.isArray(next)
    ) {
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
    trimEmptyAncestors(root, segs);
  } else {
    cursor[lastKey] = cloneJson(value);
  }
}

/** Remove now-empty object ancestors after a delete. RTDB invariant:
 *  "Empty nodes don't exist". */
function trimEmptyAncestors(
  root: Record<string, JsonValue>,
  segs: string[],
): void {
  for (let depth = segs.length - 1; depth >= 1; depth--) {
    const parentSegs = segs.slice(0, depth);
    const lastKey = segs[depth - 1]!;
    let parent: Record<string, JsonValue> = root;
    for (let i = 0; i < parentSegs.length - 1; i++) {
      const next = parent[parentSegs[i]!];
      if (
        next === undefined ||
        next === null ||
        typeof next !== 'object' ||
        Array.isArray(next)
      ) {
        return;
      }
      parent = next as Record<string, JsonValue>;
    }
    const child = parent[lastKey];
    if (
      child !== undefined &&
      child !== null &&
      typeof child === 'object' &&
      !Array.isArray(child)
    ) {
      const obj = child as Record<string, JsonValue>;
      if (Object.keys(obj).length === 0) {
        delete parent[lastKey];
        continue;
      }
    }
    return;
  }
}

// ─── Push-id generator ────────────────────────────────────────────────
//
// Lifted from `pyric/database/sandbox/push-id.ts` — the algorithm
// matches firebase-js-sdk's published `nextPushId` exactly so a sandbox-
// minted key is shape-compatible with a real `push(ref).key`. Inlined
// here so `pyric-admin/database` doesn't need to import an internal
// path from `pyric` (which isn't exported as a public subpath).

const PUSH_CHARS =
  '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

let lastPushTime = 0;
const lastRandChars: number[] = new Array(12).fill(0);

function generatePushId(now: number = Date.now()): string {
  const duplicateTime = now === lastPushTime;
  lastPushTime = now;

  const timeStampChars: string[] = new Array(8);
  let ts = now;
  for (let i = 7; i >= 0; i--) {
    timeStampChars[i] = PUSH_CHARS.charAt(ts % 64);
    ts = Math.floor(ts / 64);
  }
  if (ts !== 0) {
    throw new Error('RTDB push-id: timestamp overflow.');
  }
  let id = timeStampChars.join('');

  if (!duplicateTime) {
    for (let i = 0; i < 12; i++) {
      lastRandChars[i] = Math.floor(Math.random() * 64);
    }
  } else {
    let i: number;
    for (i = 11; i >= 0 && lastRandChars[i] === 63; i--) {
      lastRandChars[i] = 0;
    }
    if (i < 0) {
      for (let j = 0; j < 12; j++) {
        lastRandChars[j] = Math.floor(Math.random() * 64);
      }
    } else {
      lastRandChars[i] = (lastRandChars[i] ?? 0) + 1;
    }
  }

  for (let i = 0; i < 12; i++) {
    id += PUSH_CHARS.charAt(lastRandChars[i]!);
  }
  return id;
}

// ─── Reference ────────────────────────────────────────────────────────

/** The sentinel thrown by listener / transaction / query / priority
 *  methods on the sandbox `Reference`. Documented in the module-level
 *  comment under "Not implemented". */
function notImplemented(method: string): Error {
  return new Error(
    `pyric-admin/database sandbox: ${method} not implemented`,
  );
}

/** Build a sandbox `Reference` at `path`. The returned object satisfies
 *  the load-bearing subset of `firebase-admin/database`'s `Reference`
 *  shape; listener / query / transaction methods throw the "not
 *  implemented" sentinel. */
function buildSandboxRef(
  state: SandboxState,
  db: AdminDatabase,
  path: string,
): AdminReference {
  const canonical = joinPath(pathSegments(path));
  const segs = pathSegments(canonical);
  const key = segs.length === 0 ? null : segs[segs.length - 1]!;

  const ref = {
    key,
    get parent(): AdminReference | null {
      if (segs.length === 0) return null;
      return buildSandboxRef(state, db, joinPath(segs.slice(0, -1)));
    },
    get root(): AdminReference {
      return buildSandboxRef(state, db, '/');
    },
    get path(): string {
      return canonical;
    },
    toString(): string {
      return `sandbox://rtdb${canonical}`;
    },

    // ─── Data-plane methods (implemented) ────────────────────────────

    /** Set `value` at this path. `null` deletes. */
    async set(value: unknown): Promise<void> {
      writePath(state.root, canonical, value as JsonValue);
    },

    /** Read this path. Resolves to a {@link DataSnapshot}-shaped value. */
    async get(): Promise<AdminDataSnapshot> {
      const val = readPath(state.root, canonical);
      return buildSandboxSnap(state, db, canonical, val);
    },

    /** `once(eventType)` — admin-shape one-shot read. Only `'value'` is
     *  supported in the sandbox (the only event type that doesn't
     *  require a listener registry). Mirrors firebase-admin's
     *  `Reference#once('value')` for the common get-style usage. */
    async once(
      eventType: AdminEventType,
      _successCb?: unknown,
      _failureCb?: unknown,
      _context?: unknown,
    ): Promise<AdminDataSnapshot> {
      if (eventType !== 'value') {
        throw notImplemented(`once('${eventType}')`);
      }
      const val = readPath(state.root, canonical);
      return buildSandboxSnap(state, db, canonical, val);
    },

    /** Shallow merge: each key in `values` replaces the corresponding
     *  child at this path. `null` values delete. */
    async update(values: object): Promise<void> {
      if (values === null || typeof values !== 'object') {
        throw new TypeError(
          'pyric-admin/database sandbox: update expected an object.',
        );
      }
      for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
        const subSegs = [...segs, ...pathSegments(k)];
        writePath(state.root, joinPath(subSegs), v as JsonValue);
      }
    },

    /** Delete the subtree at this path. Equivalent to `set(null)`. */
    async remove(): Promise<void> {
      writePath(state.root, canonical, null);
    },

    /** Mint a 20-char push id, optionally writing `value` at the new
     *  child. Returns a Reference at the new child path. The shape
     *  matches firebase-admin's `ThenableReference` — `.then()` resolves
     *  once the (synchronous) write completes; the underlying ref is
     *  available synchronously via the returned object's own methods. */
    push(value?: unknown, onComplete?: (err: Error | null) => void): AdminThenableReference {
      const id = generatePushId();
      const childPath = joinPath([...segs, id]);
      if (value !== undefined) {
        try {
          writePath(state.root, childPath, value as JsonValue);
        } catch (err) {
          if (onComplete) onComplete(err as Error);
          throw err;
        }
      }
      if (onComplete) onComplete(null);
      const childRef = buildSandboxRef(state, db, childPath);
      // ThenableReference: the ref plus a `.then()` that resolves to it.
      // Returning a Reference with a tacked-on `.then` satisfies the
      // firebase-admin shape for the common `push(value).key` usage.
      const thenable = childRef as AdminReference & PromiseLike<AdminReference>;
      (thenable as unknown as { then: PromiseLike<AdminReference>['then'] }).then = (
        onFulfilled,
        onRejected,
      ) => Promise.resolve(childRef).then(onFulfilled, onRejected);
      (thenable as unknown as { catch: <U>(onRejected: (reason: unknown) => U | PromiseLike<U>) => Promise<AdminReference | U> }).catch = (
        onRejected,
      ) => Promise.resolve(childRef).catch(onRejected);
      return thenable as AdminThenableReference;
    },

    /** Relative ref builder. `child(parent, 'sub/path')` returns a ref
     *  at `<parent>/sub/path`. */
    child(p: string): AdminReference {
      const absSegs = [...segs, ...pathSegments(p)];
      return buildSandboxRef(state, db, joinPath(absSegs));
    },

    // ─── Not implemented in the sandbox backend ──────────────────────

    on(_eventType: AdminEventType, ..._rest: unknown[]): never {
      throw notImplemented('on');
    },
    off(_eventType?: AdminEventType, ..._rest: unknown[]): never {
      throw notImplemented('off');
    },
    onDisconnect(): never {
      throw notImplemented('onDisconnect');
    },
    transaction(..._args: unknown[]): never {
      throw notImplemented('transaction');
    },
    setPriority(..._args: unknown[]): never {
      throw notImplemented('setPriority');
    },
    setWithPriority(..._args: unknown[]): never {
      throw notImplemented('setWithPriority');
    },
    // Query builders — `orderByChild`/`equalTo`/`limitToFirst`/… aren't
    // modeled. Calling any of them returns a Query that immediately
    // throws on `get`/`on`. Keeping these as throwers (rather than
    // pretending they work) surfaces the limitation up-front.
    orderByChild(..._args: unknown[]): never {
      throw notImplemented('orderByChild');
    },
    orderByKey(..._args: unknown[]): never {
      throw notImplemented('orderByKey');
    },
    orderByValue(..._args: unknown[]): never {
      throw notImplemented('orderByValue');
    },
    orderByPriority(..._args: unknown[]): never {
      throw notImplemented('orderByPriority');
    },
    startAt(..._args: unknown[]): never {
      throw notImplemented('startAt');
    },
    startAfter(..._args: unknown[]): never {
      throw notImplemented('startAfter');
    },
    endAt(..._args: unknown[]): never {
      throw notImplemented('endAt');
    },
    endBefore(..._args: unknown[]): never {
      throw notImplemented('endBefore');
    },
    equalTo(..._args: unknown[]): never {
      throw notImplemented('equalTo');
    },
    limitToFirst(..._args: unknown[]): never {
      throw notImplemented('limitToFirst');
    },
    limitToLast(..._args: unknown[]): never {
      throw notImplemented('limitToLast');
    },
    isEqual(other: unknown): boolean {
      return (
        other !== null &&
        typeof other === 'object' &&
        (other as { path?: string }).path === canonical
      );
    },
    toJSON(): object {
      return { path: canonical };
    },

    // Required by the firebase-admin `Reference` interface but not
    // load-bearing in the sandbox. Stubbed as the database handle so
    // consumer code that reads `ref.database` doesn't crash.
    get database(): AdminDatabase {
      return db;
    },
    // `ref` on a Reference is itself (matches firebase-admin).
    get ref(): AdminReference {
      return ref as unknown as AdminReference;
    },
  };

  return ref as unknown as AdminReference;
}

// ─── DataSnapshot ─────────────────────────────────────────────────────

/** Build a sandbox `DataSnapshot` for the value at `path`. Implements
 *  the load-bearing subset of firebase-admin's `DataSnapshot` shape. */
function buildSandboxSnap(
  state: SandboxState,
  db: AdminDatabase,
  path: string,
  val: JsonValue,
): AdminDataSnapshot {
  const segs = pathSegments(path);
  const key = segs.length === 0 ? null : segs[segs.length - 1]!;
  const exists = val !== null;
  const snap = {
    key,
    get ref(): AdminReference {
      return buildSandboxRef(state, db, path);
    },
    exists(): boolean {
      return exists;
    },
    val(): unknown {
      return val;
    },
    child(p: string): AdminDataSnapshot {
      const childSegs = pathSegments(p);
      let cur: JsonValue = val;
      for (const s of childSegs) {
        if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) {
          cur = null;
          break;
        }
        cur = (cur as Record<string, JsonValue>)[s] ?? null;
      }
      return buildSandboxSnap(state, db, joinPath([...segs, ...childSegs]), cur);
    },
    hasChild(p: string): boolean {
      return snap.child(p).exists();
    },
    hasChildren(): boolean {
      return (
        val !== null &&
        typeof val === 'object' &&
        !Array.isArray(val) &&
        Object.keys(val as Record<string, JsonValue>).length > 0
      );
    },
    numChildren(): number {
      if (val === null || typeof val !== 'object' || Array.isArray(val)) return 0;
      return Object.keys(val as Record<string, JsonValue>).length;
    },
    forEach(cb: (child: AdminDataSnapshot) => boolean | void): boolean {
      if (val === null || typeof val !== 'object' || Array.isArray(val)) return false;
      for (const [k, v] of Object.entries(val as Record<string, JsonValue>)) {
        const childSnap = buildSandboxSnap(state, db, joinPath([...segs, k]), v);
        if (cb(childSnap) === true) return true;
      }
      return false;
    },
    toJSON(): unknown {
      return val;
    },
    // RTDB priority isn't modeled — return `null`, matching the SDK
    // default for a node without an explicit priority.
    getPriority(): string | number | null {
      return null;
    },
    exportVal(): unknown {
      // No priorities → `exportVal()` matches `val()`. The SDK's
      // exportVal includes `.priority` when set; we have none.
      return val;
    },
  };
  return snap as unknown as AdminDataSnapshot;
}
