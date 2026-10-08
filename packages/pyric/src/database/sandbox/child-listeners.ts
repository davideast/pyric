import type { AuthState } from 'pyric/sandbox';
import { jsonValuesEqual, joinPath, pathSegments, type JsonValue } from './data-tree.js';
import type { BackendState } from './backend-state.js';
import type { ChildListener, ChildParentSnapshot } from './listener-types.js';
import { denyResultFor, rtdbDenialContext, rtdbRulesDetail } from './operation-events.js';
import {
  executeQuery, extractOrderValue,
  type Priority, type QueryRow, type QuerySpec,
} from './query.js';
import { permissionDenied } from './rules-eval.js';
import { listenerPermissionDenied, ownersFor } from './value-listeners.js';
import { listenerAttachOwners } from '../../sandbox/attribution/listener-owners.js';
import { recordEffectRegions } from '../../sandbox/attribution/effect-regions.js';

type ChildEvent = ChildListener['event'];
type ChildSnapshot = { key: string; val: JsonValue; previousChildName: string | null };

function previousName(rows: QueryRow[], key: string): string | null {
  const index = rows.findIndex((row) => row.key === key);
  return index > 0 ? rows[index - 1]!.key : null;
}

function previousValueName(rows: Array<{ key: string; val: JsonValue }>, key: string): string | null {
  const index = rows.findIndex((row) => row.key === key);
  return index > 0 ? rows[index - 1]!.key : null;
}

export class ChildListeners {
  constructor(private readonly state: BackendState) {}

  onChild(
    auth: AuthState,
    event: ChildEvent,
    path: string,
    cb: ChildListener['cb'],
    spec?: QuerySpec,
    cancelCallback?: (error: Error) => void,
    onCanceled?: () => void,
  ): () => void {
    const at = this.state.clock.now();
    const id = this.state.events.nextListenerId();
    const attachOwners = listenerAttachOwners();
    const evaluation = this.state.rules.evaluate('read', path === '/' ? '/' : path, {
      auth,
      mockData: this.state.rulesSnapshot(),
      querySpec: spec,
    });
    if (evaluation.check !== 'allow') {
      this.state.events.operation(auth, 'listen', path, denyResultFor(evaluation.check), evaluation, {
        at, durationMs: this.state.clock.now() - at, origin: 'listener', detail: { event },
      });
      const rulesObj = rtdbRulesDetail(evaluation);
      const denial = rtdbDenialContext(evaluation, auth, 'listen', path);
      this.state.events.listener('errored', { id, path }, auth, {
        event, result: 'deny',
        error: { code: 'PERMISSION_DENIED', message: 'PERMISSION_DENIED: Permission denied', reasons: evaluation.reasons },
        reasons: evaluation.reasons,
        rules: rulesObj,
      });
      if (cancelCallback) {
        queueMicrotask(() => {
          if (onCanceled) {
            onCanceled();
          }
          cancelCallback(listenerPermissionDenied(path, denial));
        });
        return () => {};
      }
      throw permissionDenied(denial);
    }
    this.state.warnOnUnspecifiedIndex(path, spec);
    this.state.events.operation(auth, 'listen', path, 'allow', evaluation, {
      at, durationMs: this.state.clock.now() - at, origin: 'listener', detail: { event },
    });
    const listener: ChildListener = { id, auth, event, path, cb, spec, cancelCallback, onCanceled };
    this.state.childListeners.add(listener);
    this.state.events.listener('attach', listener, auth, {
      event, result: 'allow', detail: spec ? { query: spec } : undefined,
      ...(spec ? { query: spec } : {}),
      owners: attachOwners,
    });
    if (spec) {
      const rows = executeQuery(this.state.tree.read(path), spec, this.state.priorities.forChild(path));
      listener.lastWindow = rows;
      if (event === 'child_added') {
        for (const { key, value } of rows) {
          this.deliver(listener, {
            key, val: value, previousChildName: previousName(rows, key),
          }, { initial: true, query: true });
        }
      }
    } else if (event === 'child_added') {
      for (const { key, val } of this.directChildren(path)) {
        const children = this.directChildren(path);
        this.deliver(listener, {
          key, val, previousChildName: previousValueName(children, key),
        }, { initial: true });
      }
    }
    return () => {
      this.state.childListeners.delete(listener);
      this.state.events.listener('detach', listener, auth, { event });
    };
  }

  off(path: string, event?: ChildEvent, callback?: unknown): void {
    const canonical = joinPath(pathSegments(path));
    for (const listener of [...this.state.childListeners]) {
      if (event !== undefined && listener.event !== event) continue;
      if (joinPath(pathSegments(listener.path)) !== canonical) continue;
      if (callback !== undefined && listener.cb !== callback) continue;
      this.state.childListeners.delete(listener);
      this.state.events.listener('detach', listener, listener.auth, { event: listener.event });
    }
  }

  snapshotParents(): ChildParentSnapshot {
    const result: ChildParentSnapshot = new Map();
    for (const listener of this.state.childListeners) {
      const path = joinPath(pathSegments(listener.path));
      if (result.has(path)) continue;
      result.set(path, this.childStates(path));
    }
    return result;
  }

  fanOut(priorByParent: ChildParentSnapshot): void {
    if (this.state.childListeners.size === 0) return;
    const byParent = new Map<string, ChildListener[]>();
    for (const listener of this.state.childListeners) {
      if (listener.spec) {
        this.fanOutQuery(listener);
        continue;
      }
      const path = joinPath(pathSegments(listener.path));
      const listeners = byParent.get(path) ?? [];
      listeners.push(listener);
      byParent.set(path, listeners);
    }
    for (const [parentPath, listeners] of byParent) {
      const prior = priorByParent.get(parentPath) ?? new Map<string, { val: JsonValue; priority: Priority }>();
      const next = this.childStates(parentPath);
      const nextRows = [...next].map(([key, { val }]) => ({ key, val }));
      const priorRows = [...prior].map(([key, { val }]) => ({ key, val }));
      const events: Record<ChildEvent, ChildSnapshot[]> = {
        child_added: [], child_changed: [], child_removed: [], child_moved: [],
      };
      for (const [key, { val, priority }] of next) {
        const before = prior.get(key);
        if (before === undefined) {
          events.child_added.push({ key, val, previousChildName: previousValueName(nextRows, key) });
          continue;
        }
        const previousChildName = previousValueName(nextRows, key);
        if (!jsonValuesEqual(before.val, val)) events.child_changed.push({ key, val, previousChildName });
        // A plain reference orders by priority: a child moves when its own
        // priority changes, whatever happens to its neighbors or descendants.
        if (before.priority !== priority) events.child_moved.push({ key, val, previousChildName });
      }
      for (const [key, { val }] of prior) {
        if (!next.has(key)) events.child_removed.push({ key, val, previousChildName: previousValueName(priorRows, key) });
      }
      for (const listener of listeners) {
        for (const snapshot of events[listener.event]) this.deliver(listener, snapshot, {});
      }
    }
  }

  count(): number {
    return this.state.childListeners.size;
  }

  private directChildren(path: string): Array<{ key: string; val: JsonValue }> {
    const value = this.state.tree.read(path);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
    return executeQuery(
      value, { orderBy: { kind: 'priority' }, bounds: [], limit: null },
      this.state.priorities.forChild(path),
    ).map(({ key, value: val }) => ({ key, val }));
  }

  /** A parent's children in priority order, each with its value and own priority. */
  private childStates(path: string): Map<string, { val: JsonValue; priority: Priority }> {
    const priorityOf = this.state.priorities.forChild(path);
    return new Map(this.directChildren(path).map(({ key, val }) => [key, { val, priority: priorityOf(key) }]));
  }

  private fanOutQuery(listener: ChildListener): void {
    const prior = listener.lastWindow ?? [];
    const next = executeQuery(
      this.state.tree.read(listener.path), listener.spec!,
      this.state.priorities.forChild(listener.path),
    );
    listener.lastWindow = next;
    const priorByKey = new Map(prior.map((row) => [row.key, row.value]));
    const nextByKey = new Map(next.map((row) => [row.key, row.value]));
    const events: ChildSnapshot[] = [];
    if (listener.event === 'child_added') {
      for (const row of next) if (!priorByKey.has(row.key)) {
        events.push({ key: row.key, val: row.value, previousChildName: previousName(next, row.key) });
      }
    } else if (listener.event === 'child_changed') {
      for (const row of next) if (priorByKey.has(row.key) && !jsonValuesEqual(priorByKey.get(row.key)!, row.value)) {
        events.push({ key: row.key, val: row.value, previousChildName: previousName(next, row.key) });
      }
    } else if (listener.event === 'child_removed') {
      for (const row of prior) if (!nextByKey.has(row.key)) {
        events.push({ key: row.key, val: row.value, previousChildName: previousName(prior, row.key) });
      }
    } else if (listener.spec?.orderBy && listener.spec.orderBy.kind !== 'key') {
      // A child moves when its indexed value changes, as production's index
      // compares it: by equality, so a change that keeps its rank still moves.
      const priorRows = new Map(prior.map((row) => [row.key, row]));
      for (const row of next) {
        const beforeRow = priorRows.get(row.key);
        if (!beforeRow) continue;
        const before = extractOrderValue(listener.spec.orderBy, beforeRow.key, beforeRow.value, beforeRow.priority);
        const after = extractOrderValue(listener.spec.orderBy, row.key, row.value, row.priority);
        if (!jsonValuesEqual(before, after)) {
          events.push({ key: row.key, val: row.value, previousChildName: previousName(next, row.key) });
        }
      }
    }
    for (const snapshot of events) this.deliver(listener, snapshot, { query: true });
  }

  /**
   * Deliver one child event. The callback runs before the delivery event is
   * emitted so the event can carry the regions the callback touched; what the
   * callback receives, and when, is unchanged.
   */
  private deliver(listener: ChildListener, snapshot: ChildSnapshot, detail: Record<string, unknown>): void {
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
      event: listener.event, size: 1, sample: detail.query ? { key: snapshot.key, val: snapshot.val } : snapshot,
      detail, owners: ownersFor(regions),
    });
    if (!caught) return;
    this.state.events.listener('errored', listener, listener.auth, {
      event: listener.event, result: 'error',
      error: { message: thrown instanceof Error ? thrown.message : String(thrown) }, detail,
    });
  }
}
