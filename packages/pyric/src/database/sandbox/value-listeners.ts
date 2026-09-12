import type { AuthState } from 'pyric/sandbox';
import type { ListenerOwner } from '../../sandbox/types/events.js';
import { recordEffectRegions } from '../../sandbox/attribution/effect-regions.js';
import {
  listenerAttachOwners,
  type ListenerAttribution,
} from '../../sandbox/attribution/listener-owners.js';
import { jsonValuesEqual, joinPath, pathSegments, type JsonValue } from './data-tree.js';
import type { BackendState } from './backend-state.js';
import type { ValueListener, ValueListenerSnapshot } from './listener-types.js';
import { denyResultFor } from './operation-events.js';
import { executeQuery, type QueryRow, type QuerySpec } from './query.js';
import { permissionDenied, type RuleEvaluationDetails } from './rules-eval.js';

function rowsToVal(rows: QueryRow[]): JsonValue {
  if (rows.length === 0) return null;
  return Object.fromEntries(rows.map(({ key, value }) => [key, value])) as JsonValue;
}

function windowsEqual(left: QueryRow[], right: QueryRow[]): boolean {
  return left.length === right.length && left.every((row, index) => {
    const other = right[index]!;
    return row.key === other.key
      && row.priority === other.priority
      && jsonValuesEqual(row.value, other.value);
  });
}

export function listenerPermissionDenied(path: string): Error {
  const error = new Error(
    `permission_denied at ${joinPath(pathSegments(path))}: Client doesn't have permission to access the desired data.`,
  ) as Error & { code: string };
  error.code = 'PERMISSION_DENIED';
  return error;
}

export class ValueListeners {
  constructor(private readonly state: BackendState) {}

  onValue(
    auth: AuthState,
    path: string,
    cb: (snap: ValueListenerSnapshot) => void,
    query?: QuerySpec,
    cancelCallback?: (error: Error) => void,
    onCanceled?: () => void,
    attribution?: ListenerAttribution,
  ): () => void {
    const at = this.state.clock.now();
    const evaluation = this.state.rules.evaluate('read', path === '/' ? '/' : path, {
      auth,
      mockData: this.state.tree.snapshot() as Record<string, unknown>,
      querySpec: query,
    });
    if (evaluation.check !== 'allow') {
      let requestVal: { query: unknown } | undefined = undefined;
      if (query) {
        requestVal = { query };
      }
      this.state.events.operation(auth, 'listen', path, denyResultFor(evaluation.check), evaluation, {
        at, durationMs: this.state.clock.now() - at, request: requestVal, origin: 'listener',
      });
      const rulesObj = {
        engine: 'rtdb' as const,
        matchedPath: evaluation.matchedPath,
        matchedRule: evaluation.matchedRule,
        pathVariableBindings: evaluation.pathVariableBindings,
        reason: evaluation.reason,
        errorCode: evaluation.errorCode,
      };
      this.state.events.listener('errored', { id: this.state.events.nextListenerId(), path }, auth, {
        event: 'value', result: 'deny',
        error: { code: 'PERMISSION_DENIED', message: 'PERMISSION_DENIED: Permission denied', reasons: evaluation.reasons },
        reasons: evaluation.reasons,
        rules: rulesObj,
      });
      if (cancelCallback) {
        queueMicrotask(() => {
          if (onCanceled) {
            onCanceled();
          }
          cancelCallback(listenerPermissionDenied(path));
        });
        return () => {};
      }
      throw permissionDenied();
    }
    return this.attach(auth, path, cb, query, {
      origin: 'listener', result: 'allow', evaluation, at,
    }, cancelCallback, onCanceled, attribution);
  }

  adminOnValue(path: string, cb: (snap: ValueListenerSnapshot) => void, query?: QuerySpec): () => void {
    return this.attach(null, path, cb, query, {
      origin: 'admin', result: 'not-applicable', evaluation: undefined, at: this.state.clock.now(),
    });
  }

  private attach(
    auth: AuthState,
    path: string,
    cb: (snap: ValueListenerSnapshot) => void,
    query: QuerySpec | undefined,
    provenance: {
      origin: 'listener' | 'admin';
      result: 'allow' | 'not-applicable';
      evaluation: RuleEvaluationDetails | undefined;
      at: number;
    },
    cancelCallback?: (error: Error) => void,
    onCanceled?: () => void,
    attribution?: ListenerAttribution,
  ): () => void {
    const id = this.state.events.nextListenerId();
    const attachOwners = listenerAttachOwners(attribution?.owner, attribution?.owners);
    this.state.events.operation(auth, 'listen', path, provenance.result, provenance.evaluation, {
      at: provenance.at, durationMs: this.state.clock.now() - provenance.at,
      request: query ? { query } : undefined, origin: provenance.origin,
    });
    const listener: ValueListener = {
      id, auth, cb, path, query, cancelCallback, onCanceled, owners: attachOwners,
    };
    this.state.valueListeners.add(listener);
    this.state.events.listener('attach', listener, auth, {
      event: 'value', result: 'allow', detail: query ? { query } : undefined,
      ...(query ? { query } : {}),
      owners: attachOwners,
    });
    if (query) {
      const rows = executeQuery(this.state.tree.read(path), query, this.state.priorities.forChild(path));
      listener.lastWindow = rows;
      this.deliverInitial(listener, { val: rowsToVal(rows), exists: rows.length > 0, key: this.key(path), rows }, {
        initial: true, query: true,
      });
    } else {
      const snap = this.snapshot(path);
      listener.lastValue = snap.val;
      listener.lastPriorityState = this.state.priorities.stateAtOrBelow(path);
      this.deliverInitial(listener, snap, { initial: true });
    }
    return () => {
      this.state.valueListeners.delete(listener);
      this.state.events.listener('detach', listener, auth, { event: 'value' });
    };
  }

  fanOut(touched: string[]): void {
    if (this.state.valueListeners.size === 0) return;
    const touchedSet = touched.map((path) => joinPath(pathSegments(path)));
    for (const listener of this.state.valueListeners) {
      const listenerPath = joinPath(pathSegments(listener.path));
      if (!touchedSet.some((path) => pathsTouch(listenerPath, path))) continue;
      if (listener.query) {
        const rows = executeQuery(
          this.state.tree.read(listener.path), listener.query,
          this.state.priorities.forChild(listener.path),
        );
        if (windowsEqual(listener.lastWindow ?? [], rows)) {
          this.state.events.listener('suppressed', listener, listener.auth, {
            event: 'value', reason: 'no-op', detail: { query: true },
          });
          continue;
        }
        listener.lastWindow = rows;
        this.deliver(listener, {
          val: rowsToVal(rows), exists: rows.length > 0,
          key: this.key(listener.path), rows,
        }, { query: true });
        continue;
      }
      const snap = this.snapshot(listener.path);
      const priorityState = this.state.priorities.stateAtOrBelow(listener.path);
      if (jsonValuesEqual(listener.lastValue ?? null, snap.val)
        && listener.lastPriorityState === priorityState) {
        this.state.events.listener('suppressed', listener, listener.auth, {
          event: 'value', reason: 'no-op',
        });
        continue;
      }
      listener.lastValue = snap.val;
      listener.lastPriorityState = priorityState;
      this.deliver(listener, snap, {});
    }
  }

  off(path: string, callback?: unknown): void {
    const canonical = joinPath(pathSegments(path));
    for (const listener of [...this.state.valueListeners]) {
      if (joinPath(pathSegments(listener.path)) !== canonical) continue;
      if (callback !== undefined && listener.cb !== callback) continue;
      this.state.valueListeners.delete(listener);
      this.state.events.listener('detach', listener, listener.auth, { event: 'value' });
    }
  }

  count(): number {
    return this.state.valueListeners.size;
  }

  private snapshot(path: string): ValueListenerSnapshot {
    const val = this.state.tree.read(path);
    return { val, exists: val !== null, key: this.key(path) };
  }

  private key(path: string): string | null {
    const segments = pathSegments(path);
    return segments.length === 0 ? null : segments[segments.length - 1]!;
  }

  /**
   * Deliver to a subscribed listener. The callback runs before the delivery
   * event is emitted so the event can carry the regions the callback touched;
   * the callback itself sees the same snapshot, in the same order, at the
   * same moment it always did.
   */
  private deliver(listener: ValueListener, snapshot: ValueListenerSnapshot, detail: Record<string, unknown>): void {
    let thrown: unknown;
    let caught = false;
    const regions = recordEffectRegions(() => {
      try {
        listener.cb(snapshot);
      } catch (error) {
        thrown = error;
        caught = true;
      }
    });
    this.state.events.listener('delivery', listener, listener.auth, {
      event: 'value', size: snapshot.rows?.length ?? (snapshot.exists ? 1 : 0),
      sample: snapshot.val, detail, owners: ownersFor(regions),
    });
    if (!caught) return;
    this.state.events.listener('errored', listener, listener.auth, {
      event: 'value', result: 'error',
      error: { message: thrown instanceof Error ? thrown.message : String(thrown) }, detail,
    });
  }

  private deliverInitial(
    listener: ValueListener,
    snapshot: ValueListenerSnapshot,
    detail: Record<string, unknown>,
  ): void {
    let thrown: unknown;
    let caught = false;
    const regions = recordEffectRegions(() => {
      try {
        listener.cb(snapshot);
      } catch (error) {
        thrown = error;
        caught = true;
      }
    });
    if (!caught) {
      this.state.events.listener('delivery', listener, listener.auth, {
        event: 'value', size: snapshot.rows?.length ?? (snapshot.exists ? 1 : 0),
        sample: snapshot.val, detail, owners: ownersFor(regions),
      });
      return;
    }
    this.state.events.listener('errored', listener, listener.auth, {
      event: 'value', result: 'error',
      error: { message: thrown instanceof Error ? thrown.message : String(thrown) }, detail,
    });
  }
}

/** Wrap one optional owner as the event's owner array, or omit it. */
export function ownersFor(owner: ListenerOwner | undefined): ListenerOwner[] | undefined {
  if (owner === undefined) return undefined;
  return [owner];
}

function pathsTouch(listenerPath: string, touchedPath: string): boolean {
  if (listenerPath === touchedPath || listenerPath === '/') return true;
  const listenerPrefix = `${listenerPath}/`;
  const touchedPrefix = touchedPath === '/' ? '/' : `${touchedPath}/`;
  return touchedPath.startsWith(listenerPrefix) || listenerPath.startsWith(touchedPrefix);
}
