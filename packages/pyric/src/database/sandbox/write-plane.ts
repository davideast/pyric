import type { AuthState } from 'pyric/sandbox';
import type { BackendState } from './backend-state.js';
import type { ChildListeners } from './child-listeners.js';
import { joinPath, pathSegments, type JsonValue } from './data-tree.js';
import type { ChildListener, ValueListener } from './listener-types.js';
import { normalizeWrite } from './normalize.js';
import { canonicalPath, denyResultFor } from './operation-events.js';
import { validatePriority } from './priority-state.js';
import { executeQuery, type Priority, type QueryRow, type QuerySpec } from './query.js';
import { permissionDenied } from './rules-eval.js';
import { resolveSentinels } from './sentinels.js';
import { listenerPermissionDenied, type ValueListeners } from './value-listeners.js';

function rowsToVal(rows: QueryRow[]): JsonValue {
  if (rows.length === 0) return null;
  return Object.fromEntries(rows.map(({ key, value }) => [key, value])) as JsonValue;
}

export class WritePlane {
  constructor(
    private readonly state: BackendState,
    private readonly values: ValueListeners,
    private readonly children: ChildListeners,
  ) {}

  setData(seed: Record<string, JsonValue>): void {
    this.state.tree.restore({});
    this.state.priorities.clear();
    for (const [path, value] of Object.entries(seed)) {
      this.state.tree.write(path, normalizeWrite(
        resolveSentinels(value, Date.now()) as JsonValue, path === '/' ? '' : path,
      ));
    }
    this.state.mutations.mark('/');
    this.state.notifyWrite();
  }

  setRules(rules: { rules: Record<string, unknown> } | null): void {
    this.state.rules.setRules(rules);
    this.state.activeRules = rules === null ? null : structuredClone(rules);
    this.cancelDeniedListeners();
  }

  getActiveRules(): { rules: Record<string, unknown> } | null {
    return this.state.activeRules === null ? null : structuredClone(this.state.activeRules);
  }

  snapshotState(): JsonValue {
    return this.state.tree.snapshot();
  }

  adminGet(path: string): JsonValue {
    const value = this.state.tree.read(path);
    this.state.events.operation(null, 'get', path, 'not-applicable', undefined, {
      origin: 'admin', resourceBefore: { data: value, exists: value !== null },
    });
    return value;
  }

  adminGetQuery(path: string, spec: QuerySpec): QueryRow[] {
    const rows = executeQuery(this.state.tree.read(path), spec, this.state.priorities.forChild(path));
    this.state.events.operation(null, 'get', path, 'not-applicable', undefined, {
      origin: 'admin', request: { query: spec },
      resourceBefore: { data: rowsToVal(rows), exists: rows.length > 0 },
    });
    return rows;
  }

  adminSet(path: string, value: JsonValue): void {
    this.adminSetWithPriority(path, value, null);
  }

  adminSetWithPriority(path: string, value: JsonValue, priority: Priority): void {
    validatePriority(priority);
    const now = Date.now();
    const before = this.state.tree.read(path);
    const resolved = normalizeWrite(
      resolveSentinels(value, now, before) as JsonValue, path === '/' ? '' : path,
    );
    const method = resolved === null ? 'remove' : 'set';
    this.state.events.operation(null, method, path, 'not-applicable', undefined, {
      origin: 'admin', request: { data: value, resourceData: value },
      resourceBefore: { data: before, exists: before !== null },
      resourceAfter: { data: resolved, exists: resolved !== null },
    });
    const priors = this.children.snapshotParents();
    const previousPriority = this.state.priorities.stateAtOrBelow(path);
    this.state.tree.write(path, resolved);
    this.state.priorities.replace(path, resolved === null ? null : priority);
    const priorityChanged = previousPriority !== this.state.priorities.stateAtOrBelow(path);
    this.changed([path], priors, priorityChanged ? path : undefined);
    const after = this.state.tree.read(path);
    this.state.events.commit(null, after === null ? 'remove' : 'set', path, {
      data: value, priorState: before, nextState: after,
      replay: { requestTime: now }, detail: { admin: true },
    });
    this.state.notifyWrite();
  }

  adminUpdate(path: string, patch: Record<string, JsonValue>): void {
    const now = Date.now();
    const before = this.state.tree.read(path);
    const expanded = this.resolvePatch(path, patch, now);
    const multiPath = Object.keys(patch).some((key) => key.includes('/'));
    this.state.events.operation(null, 'update', path, 'not-applicable', undefined, {
      origin: 'admin', request: { data: patch, resourceData: patch },
      resourceBefore: { data: before, exists: before !== null },
      detail: multiPath
        ? { admin: true, multiPath: true, paths: Object.keys(expanded) }
        : { admin: true, multiPath: false, keys: Object.keys(patch) },
    });
    const priors = this.children.snapshotParents();
    if (multiPath) this.state.tree.multiUpdate(expanded);
    else this.state.tree.shallowUpdate(path, Object.fromEntries(
      Object.entries(expanded).map(([absolute, value]) => [pathSegments(absolute).at(-1)!, value]),
    ));
    this.state.priorities.applyUpdate(Object.entries(expanded).map(([writePath, value]) => ({ path: writePath, value })));
    this.changed(Object.keys(expanded), priors);
    const detail = multiPath
      ? { admin: true, multiPath: true, paths: Object.keys(expanded) }
      : { admin: true, multiPath: false, keys: Object.keys(patch) };
    this.state.events.commit(null, 'update', path, {
      data: patch, priorState: before, nextState: this.state.tree.read(path),
      replay: { requestTime: now }, detail,
    });
    this.state.notifyWrite();
  }

  adminRemove(path: string): void { this.adminSet(path, null); }

  adminSetPriority(path: string, priority: Priority): void {
    validatePriority(priority);
    if (this.state.tree.read(path) === null) return;
    const priors = this.children.snapshotParents();
    const changed = this.state.priorities.get(path) !== priority;
    this.state.priorities.set(path, priority);
    this.state.mutations.mark(path);
    if (changed) this.values.fanOut([path]);
    this.children.fanOut(priors, changed ? path : undefined);
    this.state.notifyWrite();
  }

  get(auth: AuthState, path: string): JsonValue {
    const at = Date.now();
    const value = this.state.tree.read(path);
    const evaluation = this.readEvaluation(auth, path);
    if (evaluation.check !== 'allow') {
      this.state.events.operation(auth, 'get', path, denyResultFor(evaluation.check), evaluation, {
        at, durationMs: Date.now() - at,
        resourceBefore: { data: value, exists: value !== null },
      });
      throw permissionDenied();
    }
    this.state.events.operation(auth, 'get', path, 'allow', evaluation, {
      at, durationMs: Date.now() - at,
      resourceBefore: { data: value, exists: value !== null },
    });
    return this.state.tree.read(path);
  }

  getQuery(auth: AuthState, path: string, spec: QuerySpec): QueryRow[] {
    const at = Date.now();
    const evaluation = this.readEvaluation(auth, path);
    if (evaluation.check !== 'allow') {
      this.state.events.operation(auth, 'get', path, denyResultFor(evaluation.check), evaluation, {
        at, durationMs: Date.now() - at, request: { query: spec },
      });
      throw permissionDenied();
    }
    const rows = executeQuery(this.state.tree.read(path), spec, this.state.priorities.forChild(path));
    this.state.events.operation(auth, 'get', path, 'allow', evaluation, {
      at, durationMs: Date.now() - at, request: { query: spec },
      resourceBefore: { data: rowsToVal(rows), exists: rows.length > 0 },
    });
    return rows;
  }

  set(auth: AuthState, path: string, value: JsonValue): void {
    this.setInternal(auth, path, value, 'set', null);
  }

  setWithPriority(auth: AuthState, path: string, value: JsonValue, priority: Priority): void {
    validatePriority(priority);
    this.setInternal(auth, path, value, 'set', priority);
  }

  remove(auth: AuthState, path: string): void {
    this.setInternal(auth, path, null, 'remove', null);
  }

  setPriority(auth: AuthState, path: string, priority: Priority): void {
    validatePriority(priority);
    const current = this.state.tree.read(path);
    const at = Date.now();
    const evaluation = this.writeEvaluation(auth, path, current);
    if (evaluation.check !== 'allow') {
      this.state.events.operation(auth, 'setPriority', path, denyResultFor(evaluation.check), evaluation, {
        at, durationMs: Date.now() - at, request: { data: priority },
        resourceBefore: { data: current, exists: current !== null },
      });
      throw permissionDenied();
    }
    if (current === null) return;
    const priors = this.children.snapshotParents();
    const changed = this.state.priorities.get(path) !== priority;
    this.state.priorities.set(path, priority);
    this.state.mutations.mark(path);
    if (changed) this.values.fanOut([path]);
    this.children.fanOut(priors, changed ? path : undefined);
    this.state.notifyWrite();
  }

  validateSet(auth: AuthState, path: string, value: unknown): void {
    const resolved = normalizeWrite(
      resolveSentinels(value, Date.now(), this.state.tree.read(path)) as JsonValue,
      path === '/' ? '' : path,
    );
    if (this.writeEvaluation(auth, path, resolved).check !== 'allow') throw permissionDenied();
  }

  validateUpdate(auth: AuthState, path: string, patch: Record<string, unknown>): void {
    const mockData = this.state.tree.snapshot() as Record<string, unknown>;
    const updates = Object.entries(patch).map(([key, value]) => {
      const absolute = joinPath([...pathSegments(path), ...pathSegments(key)]);
      return { path: absolute, value: normalizeWrite(
        resolveSentinels(value, Date.now(), this.state.tree.read(absolute)) as JsonValue, absolute,
      ) };
    });
    for (const update of updates) {
      if (this.state.rules.evaluate('write', update.path, {
        auth, mockData, newData: update.value, ...(updates.length > 1 ? { updates } : {}),
      }).check !== 'allow') throw permissionDenied();
    }
  }

  update(auth: AuthState, path: string, patch: Record<string, JsonValue>): void {
    const now = Date.now();
    const expanded = this.resolvePatch(path, patch, now);
    const multiPath = Object.keys(patch).some((key) => key.includes('/'));
    const mockData = this.state.tree.snapshot() as Record<string, unknown>;
    const updates = Object.entries(expanded).map(([writePath, value]) => ({ path: writePath, value }));
    const shallowPatch = Object.fromEntries(Object.entries(expanded).map(([absolute, value]) => [
      pathSegments(absolute).at(-1)!, value,
    ]));
    const groupId = this.state.events.nextGroupId('update');
    for (const update of updates) {
      const at = Date.now();
      const before = this.state.tree.read(update.path);
      const evaluation = this.state.rules.evaluate('write', update.path, {
        auth, mockData, newData: update.value, ...(multiPath ? { updates } : {}),
      });
      const fields = {
        at, durationMs: Date.now() - at, origin: 'batch' as const,
        request: { data: update.value, resourceData: update.value },
        resourceBefore: { data: before, exists: before !== null },
        resourceAfter: { data: update.value, exists: update.value !== null },
        groupId, groupKind: 'batch' as const,
        detail: multiPath
          ? { multiPath: true, rootPath: canonicalPath(path) }
          : { multiPath: false, rootPath: canonicalPath(path), key: pathSegments(update.path).at(-1)! },
      };
      if (evaluation.check !== 'allow') {
        this.state.events.operation(auth, 'update', update.path, denyResultFor(evaluation.check), evaluation, fields);
        throw permissionDenied();
      }
      this.state.events.operation(auth, 'update', update.path, 'allow', evaluation, fields);
    }
    const before = this.state.tree.read(path);
    const priors = this.children.snapshotParents();
    if (multiPath) this.state.tree.multiUpdate(expanded);
    else this.state.tree.shallowUpdate(path, shallowPatch);
    this.state.priorities.applyUpdate(updates);
    this.changed(Object.keys(expanded), priors);
    const after = this.state.tree.read(path);
    this.state.events.commit(auth, 'update', path, {
      data: patch, priorState: before, nextState: after, groupId, groupKind: 'batch',
      replay: { requestTime: now },
      detail: multiPath
        ? { multiPath: true, paths: Object.keys(expanded) }
        : { multiPath: false, keys: Object.keys(shallowPatch) },
    });
    this.state.events.mutation(auth, 'update', canonicalPath(path), {
      after: multiPath ? expanded : shallowPatch,
      detail: multiPath
        ? { multiPath: true, paths: Object.keys(expanded) }
        : { multiPath: false, keys: Object.keys(shallowPatch) },
    });
    this.state.notifyWrite();
  }

  private setInternal(
    auth: AuthState, path: string, value: JsonValue,
    op: 'set' | 'remove', priority: Priority,
  ): void {
    const now = Date.now();
    const resolved = normalizeWrite(
      resolveSentinels(value, now, this.state.tree.read(path)) as JsonValue,
      path === '/' ? '' : path,
    );
    const before = this.state.tree.read(path);
    const at = Date.now();
    const evaluation = this.writeEvaluation(auth, path, resolved);
    const common = {
      at, durationMs: Date.now() - at,
      request: { data: value, resourceData: value },
      resourceBefore: { data: before, exists: before !== null },
      resourceAfter: { data: resolved, exists: resolved !== null },
    };
    if (evaluation.check !== 'allow') {
      this.state.events.operation(auth, op, path, denyResultFor(evaluation.check), evaluation, common);
      throw permissionDenied();
    }
    this.state.events.operation(auth, op, path, 'allow', evaluation, common);
    const priors = this.children.snapshotParents();
    const priorPriority = this.state.priorities.stateAtOrBelow(path);
    this.state.tree.write(path, resolved);
    this.state.priorities.replace(path, resolved === null ? null : priority);
    const priorityChanged = priorPriority !== this.state.priorities.stateAtOrBelow(path);
    this.changed([path], priors, priorityChanged ? path : undefined);
    const after = this.state.tree.read(path);
    const effectiveOp = after === null ? 'remove' : op;
    this.state.events.commit(auth, effectiveOp, path, {
      data: value, priorState: before, nextState: after, replay: { requestTime: now },
    });
    this.state.events.mutation(auth, effectiveOp, canonicalPath(path), { before, after });
    this.state.notifyWrite();
  }

  private resolvePatch(path: string, patch: Record<string, JsonValue>, now: number): Record<string, JsonValue> {
    return Object.fromEntries(Object.entries(patch).map(([key, value]) => {
      const absolute = joinPath([...pathSegments(path), ...pathSegments(key)]);
      return [absolute, normalizeWrite(
        resolveSentinels(value, now, this.state.tree.read(absolute)) as JsonValue, absolute,
      )];
    }));
  }

  private changed(paths: string[], priors: ReturnType<ChildListeners['snapshotParents']>, priorityPath?: string): void {
    this.state.mutations.mark(paths);
    this.values.fanOut(paths);
    this.children.fanOut(priors, priorityPath);
  }

  private cancelDeniedListeners(): void {
    const mockData = this.state.tree.snapshot() as Record<string, unknown>;
    const deniedValues: ValueListener[] = [];
    for (const listener of [...this.state.valueListeners]) {
      if (this.state.rules.evaluate('read', listener.path, {
        auth: listener.auth, mockData,
      }).check === 'allow') continue;
      this.state.valueListeners.delete(listener);
      deniedValues.push(listener);
    }
    const deniedChildren: ChildListener[] = [];
    for (const listener of [...this.state.childListeners]) {
      if (this.state.rules.evaluate('read', listener.path, {
        auth: listener.auth, mockData,
      }).check === 'allow') continue;
      this.state.childListeners.delete(listener);
      deniedChildren.push(listener);
    }
    for (const listener of [...deniedValues, ...deniedChildren]) {
      try { listener.onCanceled?.(); } catch { /* isolated teardown */ }
      try { listener.cancelCallback?.(listenerPermissionDenied(listener.path)); } catch { /* isolated callback */ }
    }
  }

  private readEvaluation(auth: AuthState, path: string) {
    return this.state.rules.evaluate('read', path === '/' ? '/' : path, {
      auth, mockData: this.state.tree.snapshot() as Record<string, unknown>,
    });
  }

  private writeEvaluation(auth: AuthState, path: string, newData: JsonValue) {
    return this.state.rules.evaluate('write', path === '/' ? '/' : path, {
      auth, mockData: this.state.tree.snapshot() as Record<string, unknown>, newData,
    });
  }
}
