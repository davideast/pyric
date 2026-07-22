import { generatePushId } from './sandbox/push-id.js';
import { joinPath, pathSegments, type JsonValue } from './sandbox/data-tree.js';
import { authFor, targetOf } from './routing.js';
import { isQuery } from './query-shape.js';
import type { DataSnapshot, DatabaseReference, Query, ThenableReference } from './types.js';
import { buildSandboxRef } from './references.js';
import { buildSandboxQuerySnap, buildSandboxSnap } from './snapshots.js';

// ─── Reads ───────────────────────────────────────────────────────────

/**
 * `get(ref)` — one-shot read at the ref's path. Resolves to a
 * `DataSnapshot`-shaped object.
 *
 * Runs through the sandbox rule engine; denial throws the plain-`Error`
 * shape locked by the oracle.
 *
 * Absent path → `snap.val() === null && snap.exists() === false`.
 * Matches the SDK's `DataSnapshot.val()` contract.
 */
export async function get(r: DatabaseReference | Query): Promise<DataSnapshot> {
  // Query branch — windowed read.
  if (isQuery(r as object)) {
    const q = r as Query;
    const target = targetOf(q.ref as unknown as object);
    const rows = target.admin
      ? target.backend.adminGetQuery(q.ref._path, q._spec)
      : target.backend.getQuery(authFor(target), q.ref._path, q._spec);
    return buildSandboxQuerySnap(target, q.ref, rows);
  }
  const ref0 = r as DatabaseReference;
  const target = targetOf(ref0 as unknown as object);
  const val = target.admin
    ? target.backend.adminGet(ref0._path)
    : target.backend.get(authFor(target), ref0._path);
  return buildSandboxSnap(target, ref0, val);
}

/**
 * `set(ref, value)` — replace the value at `ref`'s path. `null`
 * deletes (matches the RTDB invariant — locked by oracle observation
 * `rtdb-remove-vs-set-null.json`).
 *
 * `serverTimestamp()` sentinels are resolved at write time.
 */
export async function set(r: DatabaseReference, value: unknown): Promise<void> {
  const target = targetOf(r as unknown as object);
  if (target.admin) {
    target.backend.adminSet(r._path, value as JsonValue);
  } else {
    target.backend.set(authFor(target), r._path, value as JsonValue);
  }
}

/**
 * `update(ref, values)` — partial update.
 *
 *   - When `values` keys contain `/`, the call is a **multi-path atomic
 *     update**: every listed path is written as one transaction (any
 *     denial fails the whole batch).
 *   - Otherwise it's a **shallow merge** at the ref's path: each
 *     top-level key replaces the corresponding child. `null` values
 *     delete.
 *
 * Both behaviors are sandbox-implemented per the RtdbBackend's
 * `update` method (`rtdb-modular`-spec atomic claim, matrix row #23).
 */
export async function update(
  r: DatabaseReference,
  values: Record<string, unknown>,
): Promise<void> {
  const target = targetOf(r as unknown as object);
  if (target.admin) {
    target.backend.adminUpdate(r._path, values as Record<string, JsonValue>);
  } else {
    target.backend.update(
      authFor(target),
      r._path,
      values as Record<string, JsonValue>,
    );
  }
}

/**
 * `remove(ref)` — delete the subtree at the ref's path.
 *
 * RTDB invariant (oracle: `rtdb-remove-vs-set-null.json`): equivalent
 * to `set(ref, null)`. The sandbox backend dispatches `remove` through
 * the same code path as `set(_, null)`.
 */
export async function remove(r: DatabaseReference): Promise<void> {
  const target = targetOf(r as unknown as object);
  if (target.admin) {
    target.backend.adminRemove(r._path);
  } else {
    target.backend.remove(authFor(target), r._path);
  }
}

/**
 * `push(ref, value?)` — mint an auto-id child key under `ref`'s path,
 * optionally writing `value` at the new child.
 *
 * Returns a ref at the new child path. The ref's `key` is the minted
 * id (locked by oracle observation `rtdb-push-autoid-format.json`:
 * 20 chars, leading `-`, lex-sortable).
 *
 * Production note: the key is minted **client-side** (no server
 * round-trip required); it's available synchronously on the returned
 * ref even when the optional write is denied by rules. The oracle
 * observation confirms this — the sandbox matches.
 */
export function push(r: DatabaseReference, value?: unknown): ThenableReference {
  const target = targetOf(r as unknown as object);
  // Mint the key SYNCHRONOUSLY (client-side, no rule check) so the
  // returned ref + `.key` are available even if the optional write is
  // later denied (DB-B7). The write is deferred onto the thenable's
  // promise — a rules denial REJECTS the promise rather than throwing
  // here and discarding the key.
  const key = target.backend.mintKey();
  const childPath = joinPath([...pathSegments(r._path), key]);
  // Two refs (mirroring upstream): `thenablePushRef` gets then/catch and
  // is returned; `pushRef` is a SEPARATE plain ref used as the promise's
  // fulfilled value — so resolving the promise doesn't re-enter the
  // thenable's own `then` (the self-reference unwrap trap).
  const thenablePushRef = buildSandboxRef(target, childPath);
  const pushRef = buildSandboxRef(target, childPath);
  const promise = value === undefined
    ? Promise.resolve(pushRef)
    : set(pushRef, value).then(() => pushRef);
  return makeThenable(thenablePushRef, promise);
}

/**
 * Attach `then`/`catch` to a ref so it satisfies {@link ThenableReference}.
 * Mirrors upstream's `thenablePushRef.then = promise.then.bind(promise)`
 * (`api/Reference_impl.ts:627-629`). The ref's own fields are untouched —
 * it stays a usable {@link DatabaseReference}.
 */
function makeThenable(
  pushRef: DatabaseReference,
  promise: Promise<DatabaseReference>,
): ThenableReference {
  const thenable = pushRef as ThenableReference;
  thenable.then = promise.then.bind(promise) as ThenableReference['then'];
  thenable.catch = promise.catch.bind(promise) as ThenableReference['catch'];
  return thenable;
}

/**
 * Pre-mint a push key without writing. Used by callers that need the
 * key for a multi-path update (`update(rootRef, { [\`/users/${key}\`]: ... })`).
 * Returns a freshly-minted key.
 */
export function pushKey(): string {
  return generatePushId();
}
