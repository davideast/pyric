import type { AuthState } from 'pyric/sandbox';
import { jsonValuesEqual, joinPath, pathSegments, type JsonValue } from './data-tree.js';
import type { BackendState } from './backend-state.js';
import type { ChildListener, ChildParentSnapshot } from './listener-types.js';
import { denyResultFor } from './operation-events.js';
import {
  compareValues, executeQuery, extractOrderValue,
  type QueryRow, type QuerySpec,
} from './query.js';
import { permissionDenied } from './rules-eval.js';
import { listenerPermissionDenied } from './value-listeners.js';

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

function directChildKey(parentPath: string, changedPath?: string): string | null {
  if (changedPath === undefined) return null;
  const parent = pathSegments(parentPath);
  const changed = pathSegments(changedPath);
  if (changed.length !== parent.length + 1) return null;
  if (!parent.every((segment, index) => changed[index] === segment)) return null;
  return changed[changed.length - 1] ?? null;
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
    const at = Date.now();
    const id = this.state.events.nextListenerId();
    const evaluation = this.state.rules.evaluate('read', path === '/' ? '/' : path, {
      auth,
      mockData: this.state.tree.snapshot() as Record<string, unknown>,
    });
    if (evaluation.check !== 'allow') {
      this.state.events.operation(auth, 'listen', path, denyResultFor(evaluation.check), evaluation, {
        at, durationMs: Date.now() - at, origin: 'listener', detail: { event },
      });
      const rulesObj = {
        engine: 'rtdb' as const,
        matchedPath: evaluation.matchedPath,
        matchedRule: evaluation.matchedRule,
        pathVariableBindings: evaluation.pathVariableBindings,
        reason: evaluation.reason,
        errorCode: evaluation.errorCode,
      };
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
          cancelCallback(listenerPermissionDenied(path));
        });
        return () => {};
      }
      throw permissionDenied();
    }
    this.state.events.operation(auth, 'listen', path, 'allow', evaluation, {
      at, durationMs: Date.now() - at, origin: 'listener', detail: { event },
    });
    const listener: ChildListener = { id, auth, event, path, cb, spec, cancelCallback, onCanceled };
    this.state.childListeners.add(listener);
    this.state.events.listener('attach', listener, auth, {
      event, result: 'allow', detail: spec ? { query: spec } : undefined,
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
      result.set(path, new Map(this.directChildren(path).map(({ key, val }) => [key, val])));
    }
    return result;
  }

  fanOut(priorByParent: ChildParentSnapshot, priorityChangedPath?: string): void {
    if (this.state.childListeners.size === 0) return;
    const byParent = new Map<string, ChildListener[]>();
    for (const listener of this.state.childListeners) {
      if (listener.spec) {
        this.fanOutQuery(listener, priorityChangedPath);
        continue;
      }
      const path = joinPath(pathSegments(listener.path));
      const listeners = byParent.get(path) ?? [];
      listeners.push(listener);
      byParent.set(path, listeners);
    }
    for (const [parentPath, listeners] of byParent) {
      const prior = priorByParent.get(parentPath) ?? new Map<string, JsonValue>();
      const next = new Map(this.directChildren(parentPath).map(({ key, val }) => [key, val]));
      const nextRows = [...next].map(([key, val]) => ({ key, val }));
      const priorRows = [...prior].map(([key, val]) => ({ key, val }));
      const events: Record<ChildEvent, ChildSnapshot[]> = {
        child_added: [], child_changed: [], child_removed: [], child_moved: [],
      };
      for (const [key, val] of next) {
        if (!prior.has(key)) events.child_added.push({ key, val, previousChildName: previousValueName(nextRows, key) });
        else if (!jsonValuesEqual(prior.get(key)!, val)) {
          events.child_changed.push({ key, val, previousChildName: previousValueName(nextRows, key) });
        }
      }
      for (const [key, val] of prior) {
        if (!next.has(key)) events.child_removed.push({ key, val, previousChildName: previousValueName(priorRows, key) });
      }
      const movedKey = directChildKey(parentPath, priorityChangedPath);
      if (movedKey !== null && prior.has(movedKey) && next.has(movedKey)) {
        events.child_moved.push({
          key: movedKey, val: next.get(movedKey)!,
          previousChildName: previousValueName(nextRows, movedKey),
        });
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

  private fanOutQuery(listener: ChildListener, priorityChangedPath?: string): void {
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
      const priorityKey = listener.spec.orderBy.kind === 'priority'
        ? directChildKey(listener.path, priorityChangedPath) : null;
      let handledPriorityMove = false;
      if (priorityKey !== null) {
        const row = next.find((candidate) => candidate.key === priorityKey);
        if (row && priorByKey.has(priorityKey)) {
          events.push({ key: row.key, val: row.value, previousChildName: previousName(next, row.key) });
          handledPriorityMove = true;
        }
      }
      if (!handledPriorityMove) {
        const priorRows = new Map(prior.map((row) => [row.key, row]));
        for (const row of next) {
          const beforeRow = priorRows.get(row.key);
          if (!beforeRow) continue;
          const before = extractOrderValue(listener.spec.orderBy, beforeRow.key, beforeRow.value, beforeRow.priority);
          const after = extractOrderValue(listener.spec.orderBy, row.key, row.value, row.priority);
          if (compareValues(before, after) !== 0) {
            events.push({ key: row.key, val: row.value, previousChildName: previousName(next, row.key) });
          }
        }
      }
    }
    for (const snapshot of events) this.deliver(listener, snapshot, { query: true });
  }

  private deliver(listener: ChildListener, snapshot: ChildSnapshot, detail: Record<string, unknown>): void {
    this.state.events.listener('delivery', listener, listener.auth, {
      event: listener.event, size: 1, sample: detail.query ? { key: snapshot.key, val: snapshot.val } : snapshot,
      detail,
    });
    try {
      listener.cb(snapshot);
    } catch (error) {
      this.state.events.listener('errored', listener, listener.auth, {
        event: listener.event, result: 'error',
        error: { message: error instanceof Error ? error.message : String(error) }, detail,
      });
    }
  }
}
