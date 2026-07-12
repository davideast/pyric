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
 *
 *   - **Remote sandbox arm** (sandbox target whose `Sandbox` carries the
 *     `pyric/sandbox` remote brand — a Node-side handle onto the
 *     browser-hosted SharedWorker sandbox, built by `@pyric/cli`'
 *     `connectRemoteSandbox()`) — every `Reference` data operation routes
 *     through the handle's worker-relay channel (`rtdb.get/set/update/
 *     remove/push` ops with `actAs: { mode: 'admin' }` pinned — firebase-
 *     admin's rules-bypass semantics), NOT into the process-local tree:
 *     a local tree on a remote handle would be private server-side data
 *     the browser never sees. Differences from the local arm, both
 *     deliberate upgrades:
 *
 *       - `on('value')` / `once('value')` WORK (routed through the
 *         channel's RTDB value subscription; other event types still
 *         throw "not implemented").
 *       - `update()` relays to the worker's full multi-path update
 *         (`pyric/database/modular` semantics) rather than the local
 *         arm's shallow per-key merge.
 *       - Server-side writes run through the real worker RTDB backend,
 *         so they emit `SandboxEvent`s into the unified stream (visible
 *         to Studio/agents) and fire the app's live listeners.
 *
 *     `push()` keeps its sync `.key`: the client mints the push id and
 *     sends it with the `rtdb.push` op (the worker-protocol contract).
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
import {
  isRemoteSandbox,
  type RemoteSandbox,
  type RemoteSandboxChannel,
  type Sandbox,
} from 'pyric/sandbox';

import {
  ADMIN_APP_TARGET,
  getApp,
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
 * Signature mirrors `firebase-admin/database`'s `getDatabase(app?)` and
 * `getDatabaseWithUrl(url, app)` collapsed into a single function:
 *
 *   - `getDatabase()` — default database for the DEFAULT app (resolved
 *     through `pyric-admin/app`'s registry, exactly like firebase-admin's
 *     no-arg `getDatabase()`; throws `app/no-app` when no default app has
 *     been initialized). Works on all three arms — local sandbox, remote
 *     sandbox, and prod — since it dispatches on whatever brand the
 *     registered default app carries.
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
  app?: PyricAdminApp,
  url?: string,
): AdminDatabase {
  if (app === undefined) {
    // No-arg mirror of firebase-admin's `getDatabase()` — resolve the
    // '[DEFAULT]' app from the registry (throws app/no-app on a miss).
    app = getApp();
  }
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

/** Build (or reuse) the sandbox Database handle for `sandbox`.
 *
 *  REMOTE handles dispatch here, BEFORE any local state is touched: a
 *  remote sandbox must never get a `SandboxState` (a private local tree)
 *  or a `sandbox.onEvent` wire-up (which throws on remote handles). */
function getSandboxDatabase(sandbox: Sandbox): AdminDatabase {
  if (isRemoteSandbox(sandbox)) {
    return getRemoteDatabase(sandbox);
  }
  const state = getOrCreateState(sandbox);
  return buildSandboxDatabase(state);
}

function buildSandboxDatabase(state: SandboxState): AdminDatabase {
  return buildDatabaseShell((db, path) => buildSandboxRef(state, db, path));
}

/**
 * The `Database`-level shell shared by the local and remote sandbox arms —
 * everything except how a `Reference` is built. Rules metadata isn't
 * modeled on either arm; connection toggles are no-ops (the sandbox IS the
 * local emulator).
 */
function buildDatabaseShell(
  refFactory: (db: AdminDatabase, path: string) => AdminReference,
): AdminDatabase {
  const db = {
    ref(path?: string): AdminReference {
      return refFactory(db as unknown as AdminDatabase, path ?? '/');
    },
    refFromURL(url: string): AdminReference {
      // Best-effort: strip the `https://<host>` prefix and treat the
      // remainder as a path. The sandbox has no notion of multi-database
      // hosts, so the host portion is ignored.
      const u = url.replace(/^https?:\/\/[^/]+/, '');
      return refFactory(db as unknown as AdminDatabase, u || '/');
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
      return buildSandboxSnap((p) => buildSandboxRef(state, db, p), canonical, val);
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
      return buildSandboxSnap((p) => buildSandboxRef(state, db, p), canonical, val);
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
      // CRITICAL: the promise must resolve with a PLAIN (non-thenable)
      // ref — resolving with the thenable itself would make promise
      // resolution unwrap it forever (`await push(...)` would spin).
      const resolvedRef = buildSandboxRef(state, db, childPath);
      const thenable = childRef as AdminReference & PromiseLike<AdminReference>;
      (thenable as unknown as { then: PromiseLike<AdminReference>['then'] }).then = (
        onFulfilled,
        onRejected,
      ) => Promise.resolve(resolvedRef).then(onFulfilled, onRejected);
      (thenable as unknown as { catch: <U>(onRejected: (reason: unknown) => U | PromiseLike<U>) => Promise<AdminReference | U> }).catch = (
        onRejected,
      ) => Promise.resolve(resolvedRef).catch(onRejected);
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
 *  the load-bearing subset of firebase-admin's `DataSnapshot` shape.
 *  Backend-agnostic: the snapshot is a pure (path, value) view; `refAt`
 *  supplies backend-appropriate `Reference`s (local tree or remote), so
 *  the local and remote arms share one snapshot implementation. */
function buildSandboxSnap(
  refAt: (path: string) => AdminReference,
  path: string,
  val: JsonValue,
): AdminDataSnapshot {
  const segs = pathSegments(path);
  const key = segs.length === 0 ? null : segs[segs.length - 1]!;
  const exists = val !== null;
  const snap = {
    key,
    get ref(): AdminReference {
      return refAt(path);
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
      return buildSandboxSnap(refAt, joinPath([...segs, ...childSegs]), cur);
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
        const childSnap = buildSandboxSnap(refAt, joinPath([...segs, k]), v);
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

// ─── Remote sandbox arm (remote sandbox, slice 1) ─────────────────────
//
// The app's `Sandbox` is a Node-side handle onto the browser-hosted
// SharedWorker sandbox (`pyric/sandbox`'s remote brand). Every data
// operation relays over the handle's worker channel with
// `actAs: { mode: 'admin' }` pinned — firebase-admin's rules-bypass
// semantics against the ONE tree the app + Studio + agents share. There
// is deliberately NO local state here: a `WeakMap` tree keyed off a
// remote handle would be private server-side data the browser never sees
// (exactly the failure the remote sandbox exists to avoid). No
// `session_boundary` wiring either — there is nothing local to wipe, and
// `onEvent` throws on remote handles by design.

/** firebase-admin's rules-bypass lens, pinned on every relayed operation. */
const REMOTE_ADMIN_LENS = { mode: 'admin' } as const;

/** Wire shape of an RTDB snapshot as the worker host serializes it. */
interface RemoteWireSnapshot {
  key: string | null;
  exists: boolean;
  value: unknown;
  size: number;
}

/**
 * Per-remote-handle state: the relay channel plus the `on('value')`
 * listener registry (`path → callback → detach`) that `off()` consults.
 */
interface RemoteDbState {
  channel: RemoteSandboxChannel;
  listeners: Map<string, Map<unknown, () => void>>;
}

/** One `Database` per remote handle — successive `getDatabase(app)` calls
 *  share the listener registry (matches the local arm's singleton-per-
 *  sandbox semantics). Keyed off the handle object; the data itself lives
 *  in the browser worker. */
const remoteDbBySandbox = new WeakMap<Sandbox, AdminDatabase>();

function getRemoteDatabase(sandbox: RemoteSandbox): AdminDatabase {
  let db = remoteDbBySandbox.get(sandbox);
  if (db !== undefined) return db;
  const state: RemoteDbState = {
    channel: sandbox.channel,
    listeners: new Map(),
  };
  db = buildDatabaseShell((dbHandle, path) => buildRemoteRef(state, dbHandle, path));
  remoteDbBySandbox.set(sandbox, db);
  return db;
}

/**
 * Build a remote `Reference` at `path`. Same load-bearing surface as the
 * local arm's {@link buildSandboxRef} — plus working `on('value')` /
 * `off()` (the channel relays the worker's RTDB value subscription).
 * Transactions / queries / priorities / `onDisconnect` throw the same
 * "not implemented" sentinel as the local arm.
 */
function buildRemoteRef(
  state: RemoteDbState,
  db: AdminDatabase,
  path: string,
): AdminReference {
  const canonical = joinPath(pathSegments(path));
  const segs = pathSegments(canonical);
  const key = segs.length === 0 ? null : segs[segs.length - 1]!;
  const refAt = (p: string): AdminReference => buildRemoteRef(state, db, p);
  const snapFromWire = (wire: RemoteWireSnapshot): AdminDataSnapshot =>
    buildSandboxSnap(refAt, canonical, (wire.value ?? null) as JsonValue);

  const ref = {
    key,
    get parent(): AdminReference | null {
      if (segs.length === 0) return null;
      return refAt(joinPath(segs.slice(0, -1)));
    },
    get root(): AdminReference {
      return refAt('/');
    },
    get path(): string {
      return canonical;
    },
    toString(): string {
      return `sandbox://rtdb${canonical}`;
    },

    // ─── Data-plane methods (relayed worker ops) ─────────────────────

    /** Set `value` at this path. `null` deletes. Relays `rtdb.set`. */
    async set(value: unknown): Promise<void> {
      await state.channel.op({
        method: 'rtdb.set',
        path: canonical,
        value: value ?? null,
        actAs: REMOTE_ADMIN_LENS,
      });
    },

    /** Read this path (`rtdb.get`). Resolves to a `DataSnapshot`. */
    async get(): Promise<AdminDataSnapshot> {
      const wire = (await state.channel.op({
        method: 'rtdb.get',
        path: canonical,
        actAs: REMOTE_ADMIN_LENS,
      })) as RemoteWireSnapshot;
      return snapFromWire(wire);
    },

    /** One-shot read via the channel's value subscription: the initial
     *  snapshot resolves the promise, then the subscription detaches.
     *  Only `'value'` is supported (parity with the local arm). */
    once(
      eventType: AdminEventType,
      _successCb?: unknown,
      _failureCb?: unknown,
      _context?: unknown,
    ): Promise<AdminDataSnapshot> {
      if (eventType !== 'value') {
        throw notImplemented(`once('${eventType}')`);
      }
      return new Promise<AdminDataSnapshot>((resolve, reject) => {
        let detach: (() => void) | null = null;
        let settled = false;
        detach = state.channel.subscribe(
          { target: { service: 'rtdb', path: canonical }, actAs: REMOTE_ADMIN_LENS },
          (value) => {
            if (settled) return;
            settled = true;
            resolve(snapFromWire(value as RemoteWireSnapshot));
            if (detach) detach();
          },
          (err) => {
            if (settled) return;
            settled = true;
            reject(err);
            if (detach) detach();
          },
        );
        if (settled) detach();
      });
    },

    /** Relays `rtdb.update` — the worker applies the FULL multi-path
     *  update semantics (`pyric/database/modular`), an upgrade over the
     *  local arm's shallow per-key merge. `null` values delete. */
    async update(values: object): Promise<void> {
      if (values === null || typeof values !== 'object') {
        throw new TypeError(
          'pyric-admin/database sandbox: update expected an object.',
        );
      }
      await state.channel.op({
        method: 'rtdb.update',
        path: canonical,
        values: values as Record<string, unknown>,
        actAs: REMOTE_ADMIN_LENS,
      });
    },

    /** Delete the subtree at this path (`rtdb.remove`). */
    async remove(): Promise<void> {
      await state.channel.op({
        method: 'rtdb.remove',
        path: canonical,
        actAs: REMOTE_ADMIN_LENS,
      });
    },

    /**
     * Mint a 20-char push id CLIENT-side and relay `rtdb.push` carrying it
     * (the worker-protocol contract) — so the returned
     * `ThenableReference.key` is available synchronously, exactly like the
     * local arm and firebase-admin. `.then()` settles when the relayed
     * write commits (or immediately when no value was supplied — a bare
     * `push()` performs no write, matching upstream); a write failure
     * rejects the thenable and reaches `onComplete`.
     */
    push(value?: unknown, onComplete?: (err: Error | null) => void): AdminThenableReference {
      const id = generatePushId();
      const childPath = joinPath([...segs, id]);
      const write: Promise<void> =
        value === undefined
          ? Promise.resolve()
          : state.channel
              .op({
                method: 'rtdb.push',
                path: canonical,
                key: id,
                value,
                actAs: REMOTE_ADMIN_LENS,
              })
              .then(() => undefined);
      // Surface completion without forcing the caller to await: `.then`'s
      // rejection handler also keeps a fire-and-forget push from becoming
      // an unhandled rejection (the failure still reaches `onComplete` and
      // any `.then()`/`await` on the returned thenable).
      write.then(
        () => {
          if (onComplete) onComplete(null);
        },
        (err: Error) => {
          if (onComplete) onComplete(err);
        },
      );
      const childRef = refAt(childPath);
      // CRITICAL: settle with a PLAIN (non-thenable) ref — resolving with
      // the thenable itself would make promise resolution unwrap it
      // forever (`await push(...)` would spin). Same guard as local arm.
      const resolvedRef = refAt(childPath);
      const thenable = childRef as AdminReference & PromiseLike<AdminReference>;
      (thenable as unknown as { then: PromiseLike<AdminReference>['then'] }).then = (
        onFulfilled,
        onRejected,
      ) => write.then(() => resolvedRef).then(onFulfilled, onRejected);
      (thenable as unknown as { catch: <U>(onRejected: (reason: unknown) => U | PromiseLike<U>) => Promise<AdminReference | U> }).catch = (
        onRejected,
      ) => write.then(() => resolvedRef).catch(onRejected);
      return thenable as AdminThenableReference;
    },

    /** Relative ref builder — pure local path manipulation. */
    child(p: string): AdminReference {
      return refAt(joinPath([...segs, ...pathSegments(p)]));
    },

    // ─── Value listeners (relayed worker subscription) ────────────────

    /**
     * `on('value', callback)` — routed through the channel's RTDB value
     * subscription: the callback fires with the initial snapshot and on
     * every subsequent change (including changes made by the browser app,
     * Studio, or agents — one shared tree). A subscription-establishment
     * failure routes to `cancelCallback` when one is supplied. Other
     * event types (`child_added`, …) still throw "not implemented" —
     * the worker relays only value subscriptions today.
     */
    on(
      eventType: AdminEventType,
      callback: (snap: AdminDataSnapshot, prevChildKey?: string | null) => unknown,
      cancelCallbackOrContext?: ((err: Error) => unknown) | object | null,
      _context?: object | null,
    ): (snap: AdminDataSnapshot, prevChildKey?: string | null) => unknown {
      if (eventType !== 'value') {
        throw notImplemented(`on('${eventType}')`);
      }
      const cancelCallback =
        typeof cancelCallbackOrContext === 'function'
          ? (cancelCallbackOrContext as (err: Error) => unknown)
          : undefined;
      const detach = state.channel.subscribe(
        { target: { service: 'rtdb', path: canonical }, actAs: REMOTE_ADMIN_LENS },
        (value) => {
          callback(snapFromWire(value as RemoteWireSnapshot));
        },
        (err) => {
          detachListener(state, canonical, callback);
          if (cancelCallback) cancelCallback(err);
          else console.error(`pyric-admin/database: on('value') subscription failed at ${canonical}:`, err);
        },
      );
      let atPath = state.listeners.get(canonical);
      if (atPath === undefined) {
        atPath = new Map();
        state.listeners.set(canonical, atPath);
      }
      // Re-registering the same callback replaces the prior registration
      // (detach it first so the old worker subscription doesn't leak).
      atPath.get(callback)?.();
      atPath.set(callback, detach);
      return callback;
    },

    /**
     * Detach value listeners at this path: `off('value', callback)` removes
     * that registration; `off()` / `off('value')` removes all of them.
     * Unknown callbacks and other event types are no-ops (nothing else can
     * be registered on the remote arm).
     */
    off(
      eventType?: AdminEventType,
      callback?: (snap: AdminDataSnapshot, prevChildKey?: string | null) => unknown,
      _context?: object | null,
    ): void {
      if (eventType !== undefined && eventType !== 'value') return;
      if (callback !== undefined) {
        detachListener(state, canonical, callback);
        return;
      }
      const atPath = state.listeners.get(canonical);
      if (atPath === undefined) return;
      for (const detach of atPath.values()) detach();
      state.listeners.delete(canonical);
    },

    // ─── Not implemented on the remote arm (parity with local) ────────

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
    get database(): AdminDatabase {
      return db;
    },
    get ref(): AdminReference {
      return ref as unknown as AdminReference;
    },
  };

  return ref as unknown as AdminReference;
}

/** Remove one `on('value')` registration (and its worker subscription). */
function detachListener(
  state: RemoteDbState,
  path: string,
  callback: unknown,
): void {
  const atPath = state.listeners.get(path);
  const detach = atPath?.get(callback);
  if (atPath === undefined || detach === undefined) return;
  atPath.delete(callback);
  if (atPath.size === 0) state.listeners.delete(path);
  detach();
}
