import { runSdkWrite } from '../sandbox/internal/sdk-write-activity.js';
import {
  abortColdTransactionsOnClientWrite,
  markClientPathsWarm,
  updateTargetPaths,
} from './client-cache-state.js';
import {
  enqueueOfflineClientSet,
  enqueueOfflineClientSetPriority,
  enqueueOfflineClientUpdate,
  isClientOffline,
  offlineClientGet,
} from './offline-client-state.js';
import { generatePushId } from './sandbox/push-id.js';
import { joinPath, pathSegments, type JsonValue } from './sandbox/data-tree.js';
import { authFor, isAdminFor, targetOf } from './routing.js';
import { hasNonFiniteQueryLimit, isDefaultQuerySpec, isQuery } from './query-shape.js';
import { finishSdkRead } from '../sandbox/internal/sdk-activity.js';
import { beginDatabaseActivity } from './sdk-activity.js';
import type { DataSnapshot, DatabaseReference, Query, ThenableReference } from './types.js';
import { buildSandboxRef } from './references.js';
import { assertGettablePath } from './info-read.js';
import { validateUpdatePaths, validateWritablePath } from './writable-path.js';
import { errorPrefix, validatePriorityArg, validateUpdate, validateWrite } from './sandbox/normalize.js';
import { loadsAllData } from './internal/query-projection.js';
import { buildSandboxQuerySnap, buildSandboxSnap } from './snapshots.js';

// --- Reads ---

/**
 * `get(ref)` -- one-shot read at the ref's path. Resolves to a
 * `DataSnapshot`-shaped object.
 *
 * Runs through the sandbox rule engine; denial throws the plain-`Error`
 * shape locked by the oracle.
 *
 * Absent path -> `snap.val() === null && snap.exists() === false`.
 * Matches the SDK's `DataSnapshot.val()` contract.
 */
export function get(r: DatabaseReference | Query): Promise<DataSnapshot> {
  const query = isQuery(r as object) && !isDefaultQuerySpec((r as Query)._spec) ? r as Query : undefined;
  const ref0 = isQuery(r as object) ? (r as Query).ref : r as DatabaseReference;
  const target = targetOf(ref0 as object);
  const activity = beginDatabaseActivity(r, 'get', 'operation');
  // Keep the existing single Promise reaction and exact backend error object.
  return Promise.resolve().then(() => {
    try {
      assertGettablePath(ref0._path);
      if (query !== undefined && hasNonFiniteQueryLimit(query._spec)) {
        return new Promise<DataSnapshot>(() => {});
      }
      const readOnline = (): DataSnapshot => {
        if (query) {
          let result: ReturnType<typeof target.backend.adminGetQuery>;
          if (isAdminFor(target)) {
            result = target.backend.adminGetQuery(query.ref._path, query._spec);
          } else {
            result = target.backend.getQuery(authFor(target), query.ref._path, query._spec);
          }
          markClientPathsWarm(target, [query.ref._path]);
          return buildSandboxQuerySnap(target, query.ref, result.rows, loadsAllData(query._spec), result.val);
        }
        let val: JsonValue;
        if (isAdminFor(target)) {
          val = target.backend.adminGet(ref0._path);
        } else {
          val = target.backend.get(authFor(target), ref0._path);
        }
        markClientPathsWarm(target, [ref0._path]);
        return buildSandboxSnap(target, ref0, val);
      };
      const offlinePending = offlineClientGet(target, ref0, query, readOnline);
      if (offlinePending !== undefined) {
        return offlinePending.then((snap) => finishSdkRead(activity, snap));
      }
      return finishSdkRead(activity, readOnline());
    } catch (error) {
      activity.fail();
      throw error;
    }
  });
}

/**
 * `set(ref, value)` -- replace the value at `ref`'s path. `null`
 * deletes (matches the RTDB invariant -- locked by oracle observation
 * `rtdb-remove-vs-set-null.json`).
 *
 * `serverTimestamp()` sentinels are resolved at write time.
 */
export function set(r: DatabaseReference, value: unknown): Promise<void> {
  validateWritablePath('set', r._path);
  const target = targetOf(r as unknown as object);
  validateWrite(value, r._path, errorPrefix('set', 'value'), {
    checkInlinePriorities: !isAdminFor(target),
    checkServerValues: true,
  });
  abortColdTransactionsOnClientWrite(target, [r._path]);
  markClientPathsWarm(target, [r._path]);
  return runSdkWrite(beginDatabaseActivity(r, 'set', 'operation'), () => {
    if (isAdminFor(target)) {
      target.backend.adminSet(r._path, value as JsonValue);
      return;
    }
    if (isClientOffline(target)) {
      return enqueueOfflineClientSet(target, r._path, value, null, false, () =>
        target.backend.enqueueClientSet(authFor(target), r._path, value as JsonValue),
      );
    }
    return target.backend.enqueueClientSet(authFor(target), r._path, value as JsonValue);
  });
}

export function setPriority(
  r: DatabaseReference,
  priority: string | number | null,
): Promise<void> {
  validateWritablePath('setPriority', r._path);
  const target = targetOf(r as unknown as object);
  validatePriorityArg('setPriority', priority, { checkServerValues: true });
  abortColdTransactionsOnClientWrite(target, [r._path]);
  markClientPathsWarm(target, [r._path]);
  return runSdkWrite(beginDatabaseActivity(r, 'setPriority', 'operation'), () => {
    if (isAdminFor(target)) {
      target.backend.adminSetPriority(r._path, priority);
      return;
    }
    if (isClientOffline(target)) {
      return enqueueOfflineClientSetPriority(target, r._path, priority, () =>
        target.backend.enqueueClientSetPriority(authFor(target), r._path, priority),
      );
    }
    return target.backend.enqueueClientSetPriority(authFor(target), r._path, priority);
  });
}

export function setWithPriority(
  r: DatabaseReference,
  value: unknown,
  priority: string | number | null,
): Promise<void> {
  validateWritablePath('setWithPriority', r._path);
  const target = targetOf(r as unknown as object);
  validateWrite(value, r._path, errorPrefix('setWithPriority', 'value'), {
    checkInlinePriorities: !isAdminFor(target),
    checkServerValues: true,
  });
  validatePriorityArg('setWithPriority', priority, { checkServerValues: true });
  abortColdTransactionsOnClientWrite(target, [r._path]);
  markClientPathsWarm(target, [r._path]);
  return runSdkWrite(beginDatabaseActivity(r, 'setWithPriority', 'operation'), () => {
    if (isAdminFor(target)) {
      target.backend.adminSetWithPriority(r._path, value as JsonValue, priority);
      return;
    }
    if (isClientOffline(target)) {
      return enqueueOfflineClientSet(target, r._path, value, priority, true, () =>
        target.backend.enqueueClientSetWithPriority(
          authFor(target),
          r._path,
          value as JsonValue,
          priority,
        ),
      );
    }
    return target.backend.enqueueClientSetWithPriority(
      authFor(target),
      r._path,
      value as JsonValue,
      priority,
    );
  });
}

/**
 * `update(ref, values)` -- partial update.
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
 *
 * Applies when called, as `set()` does, so a client's writes land in call
 * order (RT-1, #1359; upstream applies each write to its local view at once).
 */
export function update(
  r: DatabaseReference,
  values: Record<string, unknown>,
): Promise<void> {
  const target = targetOf(r as unknown as object);
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error(`${errorPrefix('update', 'values')} must be an object containing the children to replace.`);
  }
  validateUpdatePaths(values);
  validateUpdate(values, r._path, 'update', {
    checkInlinePriorities: !isAdminFor(target),
    checkServerValues: true,
  });
  const targetPaths = updateTargetPaths(r._path, values);
  abortColdTransactionsOnClientWrite(target, targetPaths);
  markClientPathsWarm(target, targetPaths);
  return runSdkWrite(beginDatabaseActivity(r, 'update', 'operation'), () => {
    if (isAdminFor(target)) {
      target.backend.adminUpdate(r._path, values as Record<string, JsonValue>);
      return;
    }
    if (isClientOffline(target)) {
      return enqueueOfflineClientUpdate(target, r._path, values, () =>
        target.backend.enqueueClientUpdate(
          authFor(target),
          r._path,
          values as Record<string, JsonValue>,
        ),
      );
    }
    return target.backend.enqueueClientUpdate(
      authFor(target),
      r._path,
      values as Record<string, JsonValue>,
    );
  });
}

/**
 * `remove(ref)` -- delete the subtree at the ref's path.
 *
 * RTDB invariant (oracle: `rtdb-remove-vs-set-null.json`): equivalent
 * to `set(ref, null)`. The sandbox backend dispatches `remove` through
 * the same code path as `set(_, null)`.
 */
export function remove(r: DatabaseReference): Promise<void> {
  validateWritablePath('remove', r._path);
  const target = targetOf(r as unknown as object);
  abortColdTransactionsOnClientWrite(target, [r._path]);
  markClientPathsWarm(target, [r._path]);
  return runSdkWrite(beginDatabaseActivity(r, 'remove', 'operation'), () => {
    if (isAdminFor(target)) {
      target.backend.adminRemove(r._path);
      return;
    }
    if (isClientOffline(target)) {
      return enqueueOfflineClientSet(target, r._path, null, null, false, () =>
        target.backend.enqueueClientRemove(authFor(target), r._path),
      );
    }
    return target.backend.enqueueClientRemove(authFor(target), r._path);
  });
}

/**
 * `push(ref, value?)` -- mint an auto-id child key under `ref`'s path,
 * optionally writing `value` at the new child.
 *
 * Returns a ref at the new child path. The ref's `key` is the minted
 * id (locked by oracle observation `rtdb-push-autoid-format.json`:
 * 20 chars, leading `-`, lex-sortable).
 *
 * Production note: the key is minted **client-side** (no server
 * round-trip required); it's available synchronously on the returned
 * ref even when the optional write is denied by rules. The oracle
 * observation confirms this -- the sandbox matches.
 */
export function push(r: DatabaseReference, value?: unknown): ThenableReference {
  validateWritablePath('push', r._path);
  const target = targetOf(r as unknown as object);
  if (value !== undefined) {
    // The SDK validates the optional value synchronously before minting a child
    // key, naming the parent's path rather than a minted child's.
    validateWrite(value, r._path, errorPrefix('push', 'value'), {
      checkInlinePriorities: !isAdminFor(target),
      checkServerValues: true,
    });
  }
  // Mint the key SYNCHRONOUSLY (client-side, no rule check) so the
  // returned ref + `.key` are available even if the optional write is
  // later denied (DB-B7). The write is deferred onto the thenable's
  // promise -- a rules denial REJECTS the promise rather than throwing
  // here and discarding the key.
  const key = target.backend.mintKey();
  const childPath = joinPath([...pathSegments(r._path), key]);
  // Two refs (mirroring upstream): `thenablePushRef` gets then/catch and
  // is returned; `pushRef` is a SEPARATE plain ref used as the promise's
  // fulfilled value -- so resolving the promise doesn't re-enter the
  // thenable's own `then` (the self-reference unwrap trap).
  const thenablePushRef = buildSandboxRef(target, childPath);
  const pushRef = buildSandboxRef(target, childPath);
  let promise: Promise<DatabaseReference>;
  if (value === undefined) {
    promise = Promise.resolve(pushRef);
  } else {
    abortColdTransactionsOnClientWrite(target, [childPath]);
    markClientPathsWarm(target, [childPath]);
    promise = runSdkWrite(beginDatabaseActivity(pushRef, 'push', 'operation'), async () => {
      if (isAdminFor(target)) {
        target.backend.adminSet(childPath, value as JsonValue);
      } else if (isClientOffline(target)) {
        await enqueueOfflineClientSet(target, childPath, value, null, false, () =>
          target.backend.enqueueClientSet(authFor(target), childPath, value as JsonValue),
        );
      } else {
        await target.backend.enqueueClientSet(authFor(target), childPath, value as JsonValue);
      }
      return pushRef;
    });
  }
  return makeThenable(thenablePushRef, promise);
}

/**
 * Attach `then`/`catch` to a ref so it satisfies {@link ThenableReference}.
 * Mirrors upstream's `thenablePushRef.then = promise.then.bind(promise)`
 * (`api/Reference_impl.ts:627-629`). The ref's own fields are untouched --
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
