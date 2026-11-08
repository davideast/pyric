/**
 * Local in-process `pyric-admin/database` arm backed by a per-`Sandbox`
 * in-memory tree with `ServerValue` sentinel resolution and callback parity.
 */

import type { Sandbox } from 'pyric/sandbox';
import {
  createDatabaseInstanceRegistry,
  getClock,
  type DatabaseInstance,
  type DatabaseInstanceRegistry,
} from 'pyric/sandbox/internal';
import {
  assertGettablePath,
  normalizeNode,
  resolveSentinels,
} from 'pyric/database/internal';
import { buildDatabaseShell } from './database-shell.js';
import { buildSandboxSnap } from './data-snapshot.js';
import {
  generatePushId,
  joinPath,
  pathSegments,
  readPath,
  settled,
  validateValueArg,
  validateValuesArg,
  writePath,
  type SandboxState,
} from './tree-store.js';
import {
  notImplemented,
  resolveOnceCallbacks,
  type Database,
  type DataSnapshot,
  type EventType,
  type Reference,
  type ThenableReference,
} from './types.js';

interface LocalInstance {
  state: SandboxState;
  db?: Database;
}

const localInstancesBySandbox = new WeakMap<Sandbox, DatabaseInstanceRegistry<LocalInstance>>();

function localInstances(sandbox: Sandbox): DatabaseInstanceRegistry<LocalInstance> {
  const existing = localInstancesBySandbox.get(sandbox);
  if (existing !== undefined) return existing;
  const registry: DatabaseInstanceRegistry<LocalInstance> = createDatabaseInstanceRegistry({
    create: () => ({ state: { root: {}, sandbox } }),
  });
  localInstancesBySandbox.set(sandbox, registry);
  sandbox.onEvent((event) => {
    if (event.kind === 'session_boundary') {
      for (const [, entry] of registry.entries()) entry.state.root = {};
    }
  });
  return registry;
}

export function getLocalDatabase(sandbox: Sandbox, instance: DatabaseInstance | undefined): Database {
  const registry = localInstances(sandbox);
  const entry = registry.getOrCreate(registry.keyOf(instance));
  const state = entry.state;
  entry.db ??= buildDatabaseShell(instance, (handle, path) => buildSandboxRef(state, handle, path));
  return entry.db;
}

function buildSandboxRef(
  state: SandboxState,
  db: Database,
  path: string,
): Reference {
  const canonical = joinPath(pathSegments(path));
  const segs = pathSegments(canonical);
  const key = segs.length === 0 ? null : segs[segs.length - 1]!;

  const ref = {
    key,
    get parent(): Reference | null {
      if (segs.length === 0) return null;
      return buildSandboxRef(state, db, joinPath(segs.slice(0, -1)));
    },
    get root(): Reference {
      return buildSandboxRef(state, db, '/');
    },
    get path(): string {
      return canonical;
    },
    toString(): string {
      return `sandbox://rtdb${canonical}`;
    },

    set(value: unknown, onComplete?: (err: Error | null) => void): Promise<void> {
      const stored = validateValueArg('set', segs, value);
      return settled(() => {
        const now = getClock(state.sandbox).now();
        const resolved = normalizeNode(
          resolveSentinels(stored, now, readPath(state.root, canonical)),
        );
        writePath(state.root, canonical, resolved);
      }, onComplete);
    },

    async get(): Promise<DataSnapshot> {
      assertGettablePath(canonical);
      const val = readPath(state.root, canonical);
      return buildSandboxSnap((p) => buildSandboxRef(state, db, p), canonical, val);
    },

    async once(
      eventType: EventType,
      successCb?: unknown,
      failureCallbackOrContext?: unknown,
      context?: unknown,
    ): Promise<DataSnapshot> {
      if (eventType !== 'value') {
        throw notImplemented(`once('${eventType}')`);
      }
      const { failureCb, boundContext } = resolveOnceCallbacks(failureCallbackOrContext, context);
      let snap: DataSnapshot;
      try {
        const val = readPath(state.root, canonical);
        snap = buildSandboxSnap((p) => buildSandboxRef(state, db, p), canonical, val);
      } catch (err) {
        if (failureCb !== undefined) {
          try {
            failureCb.call(boundContext, err as Error);
          } catch {
            // Ignore secondary callback throw before rejecting with the read error.
          }
        }
        throw err;
      }
      if (typeof successCb === 'function') {
        try {
          (successCb as (s: DataSnapshot) => unknown).call(boundContext, snap);
        } catch {
          // Callback error does not reject the once() promise once snapshot arrived.
        }
      }
      return snap;
    },

    update(values: object, onComplete?: (err: Error | null) => void): Promise<void> {
      const patch = validateValuesArg(segs, values);
      return settled(() => {
        const now = getClock(state.sandbox).now();
        for (const [k, v] of Object.entries(patch)) {
          const targetPath = joinPath([...segs, ...pathSegments(k)]);
          const resolved = normalizeNode(
            resolveSentinels(v, now, readPath(state.root, targetPath)),
          );
          writePath(state.root, targetPath, resolved);
        }
      }, onComplete);
    },

    remove(onComplete?: (err: Error | null) => void): Promise<void> {
      return settled(() => writePath(state.root, canonical, null), onComplete);
    },

    push(value?: unknown, onComplete?: (err: Error | null) => void): ThenableReference {
      const stored = value === undefined ? undefined : validateValueArg('push', segs, value);
      const now = getClock(state.sandbox).now();
      const id = generatePushId(now);
      const childPath = joinPath([...segs, id]);
      let writeOutcome: Promise<void>;
      if (stored !== undefined) {
        writeOutcome = settled(() => {
          const resolved = normalizeNode(resolveSentinels(stored, now, null));
          writePath(state.root, childPath, resolved);
        }, onComplete);
      } else {
        writeOutcome = settled(() => {}, onComplete);
      }
      writeOutcome.catch(() => {});
      const childRef = buildSandboxRef(state, db, childPath);
      const resolvedRef = buildSandboxRef(state, db, childPath);
      const outcome = writeOutcome.then(() => resolvedRef);
      outcome.catch(() => {});
      const thenable = childRef as Reference & PromiseLike<Reference>;
      (thenable as unknown as { then: PromiseLike<Reference>['then'] }).then = (
        onFulfilled,
        onRejected,
      ) => outcome.then(onFulfilled, onRejected);
      (thenable as unknown as { catch: <U>(onRejected: (reason: unknown) => U | PromiseLike<U>) => Promise<Reference | U> }).catch = (
        onRejected,
      ) => outcome.catch(onRejected);
      return thenable as ThenableReference;
    },

    child(p: string): Reference {
      const absSegs = [...segs, ...pathSegments(p)];
      return buildSandboxRef(state, db, joinPath(absSegs));
    },

    on(_eventType: EventType, ..._rest: unknown[]): never {
      throw notImplemented('on');
    },
    off(_eventType?: EventType, ..._rest: unknown[]): never {
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
    get database(): Database {
      return db;
    },
    get ref(): Reference {
      return ref as unknown as Reference;
    },
  };

  return ref as unknown as Reference;
}
