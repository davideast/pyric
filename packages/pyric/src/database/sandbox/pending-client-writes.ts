import type { AuthState } from 'pyric/sandbox';
import type { BackendState } from './backend-state.js';
import type { ChildListeners } from './child-listeners.js';
import { joinPath, pathSegments, type JsonValue } from './data-tree.js';
import { fanOutAllListeners } from './listener-fanout.js';
import { listenerReadDependsOnPaths } from './listener-read-dependency.js';
import type { ChildListener, ValueListener } from './listener-types.js';
import { errorPrefix, normalizeWrite, writePriority, type InlinePriority } from './normalize.js';
import { validateNestedPriorities, validatePriority } from './priority-state.js';
import type { Priority } from './query.js';
import { resolveSentinels } from './sentinels.js';
import type { ValueListeners } from './value-listeners.js';
import type { WritePlane } from './write-plane.js';

interface PendingWriteEntry {
  requestTime: number;
  withProvenance: <T>(fn: () => T) => T;
  paths: string[];
  cancelled: boolean;
  applyOptimistic: (state: BackendState, now: number) => string[];
  commitServer: (writes: WritePlane) => void;
}

function storeOptimisticNestedPriorities(
  state: BackendState,
  basePath: string,
  nested: readonly InlinePriority[],
): void {
  const baseSegs = pathSegments(basePath);
  for (const entry of nested) {
    const childPath = joinPath([...baseSegs, ...entry.segments]);
    let nextPriority: Priority = null;
    if (state.tree.read(childPath) !== null) {
      nextPriority = entry.priority;
    }
    state.priorities.set(childPath, nextPriority);
  }
}

function applyOptimisticSet(
  state: BackendState,
  path: string,
  value: JsonValue,
  priority: Priority,
  prioritySupplied: boolean,
  now: number,
): string[] {
  const resolvedInput = resolveSentinels(value, now, state.rulesSnapshotAt(path));
  let normPath = path;
  if (path === '/') {
    normPath = '';
  }
  const resolved = normalizeWrite(resolvedInput, normPath);
  const resolvedArgPriority = resolveSentinels(priority, now, state.priorities.get(path)) as Priority;
  validatePriority(resolvedArgPriority);
  let basePrio: Priority = null;
  if (prioritySupplied) {
    basePrio = resolvedArgPriority;
  }
  const written = writePriority(resolvedInput, basePrio);
  validatePriority(written.priority);
  validateNestedPriorities(pathSegments(path), written.nested);
  state.tree.write(path, resolved);
  let effectivePriority: Priority = null;
  if (resolved !== null) {
    effectivePriority = written.priority;
  }
  state.priorities.replace(path, effectivePriority, (p) => state.tree.read(p) !== null);
  storeOptimisticNestedPriorities(state, path, written.nested);
  return [path];
}

function applyOptimisticUpdate(
  state: BackendState,
  path: string,
  patch: Record<string, JsonValue>,
  now: number,
): string[] {
  const keys = Object.keys(patch);
  if (keys.length === 0) {
    return [];
  }
  const multiPath = keys.some((key) => key.includes('/'));
  const dataExpanded: Record<string, JsonValue> = {};
  const priorityUpdates: Array<{ nodePath: string; priority: Priority }> = [];
  const inlineMap = new Map<string, InlinePriority[]>();
  const changedPaths: string[] = [];

  for (const [key, rawValue] of Object.entries(patch)) {
    const segs = [...pathSegments(path), ...pathSegments(key)];
    const absolute = joinPath(segs);
    if (segs.at(-1) === '.priority') {
      const nodePath = joinPath(segs.slice(0, -1));
      const priorPrio = state.priorities.get(nodePath);
      const resolvedInput = resolveSentinels(rawValue, now, priorPrio);
      const resolved = normalizeWrite(resolvedInput, absolute, errorPrefix('update', 'values'));
      validatePriority(resolved as Priority);
      priorityUpdates.push({ nodePath, priority: resolved as Priority });
      changedPaths.push(nodePath);
      continue;
    }
    const currentVal = state.rulesSnapshotAt(absolute);
    const resolvedInput = resolveSentinels(rawValue, now, currentVal);
    const resolved = normalizeWrite(resolvedInput, absolute, errorPrefix('update', 'values'));
    const written = writePriority(resolvedInput, null);
    validatePriority(written.priority);
    validateNestedPriorities(segs, written.nested);
    const priorities: InlinePriority[] = [];
    if (written.inline) {
      priorities.push({ segments: [], priority: written.priority });
    }
    priorities.push(...written.nested);
    dataExpanded[absolute] = resolved;
    inlineMap.set(absolute, priorities);
    changedPaths.push(absolute);
  }

  if (Object.keys(dataExpanded).length > 0) {
    if (multiPath) {
      state.tree.multiUpdate(dataExpanded);
    } else {
      const shallow: Record<string, JsonValue> = {};
      for (const [absolute, val] of Object.entries(dataExpanded)) {
        const last = pathSegments(absolute).at(-1);
        if (last !== undefined) {
          shallow[last] = val;
        }
      }
      state.tree.shallowUpdate(path, shallow);
    }
  }
  const hasNode = (p: string): boolean => state.tree.read(p) !== null;
  state.priorities.applyUpdate(
    Object.entries(dataExpanded).map(([writePath, value]) => ({ path: writePath, value })),
    hasNode,
  );
  for (const [entryPath, entries] of inlineMap) {
    const own = entries.find((entry) => entry.segments.length === 0);
    if (own !== undefined) {
      let ownPrio: Priority = null;
      if (hasNode(entryPath)) {
        ownPrio = own.priority;
      }
      state.priorities.set(entryPath, ownPrio);
    }
    storeOptimisticNestedPriorities(
      state,
      entryPath,
      entries.filter((entry) => entry.segments.length > 0),
    );
  }
  for (const item of priorityUpdates) {
    let nextPrio: Priority = null;
    if (hasNode(item.nodePath)) {
      nextPrio = item.priority;
    }
    state.priorities.set(item.nodePath, nextPrio);
  }
  return Array.from(new Set(changedPaths));
}

function applyOptimisticSetPriority(
  state: BackendState,
  path: string,
  priority: Priority,
  now: number,
): string[] {
  const resolved = resolveSentinels(priority, now, state.priorities.get(path)) as Priority;
  validatePriority(resolved);
  if (state.tree.read(path) === null) {
    return [];
  }
  state.priorities.set(path, resolved);
  return [path];
}

function withFilteredListeners(
  state: BackendState,
  keepValue: (listener: ValueListener) => boolean,
  keepChild: (listener: ChildListener) => boolean,
  run: () => void,
): void {
  const priorValues = [...state.valueListeners];
  const priorChildren = [...state.childListeners];
  const suppressedValues = new Set<ValueListener>();
  for (const listener of priorValues) {
    if (!keepValue(listener)) {
      suppressedValues.add(listener);
    }
  }
  const suppressedChildren = new Set<ChildListener>();
  for (const listener of priorChildren) {
    if (!keepChild(listener)) {
      suppressedChildren.add(listener);
    }
  }
  if (suppressedValues.size === 0 && suppressedChildren.size === 0) {
    run();
    return;
  }
  for (const listener of suppressedValues) {
    state.valueListeners.delete(listener);
  }
  for (const listener of suppressedChildren) {
    state.childListeners.delete(listener);
  }
  try {
    run();
  } finally {
    const remainingValues = new Set(state.valueListeners);
    state.valueListeners.clear();
    for (const listener of priorValues) {
      if (remainingValues.has(listener) || suppressedValues.has(listener)) {
        state.valueListeners.add(listener);
      }
    }
    for (const listener of remainingValues) {
      if (!state.valueListeners.has(listener)) {
        state.valueListeners.add(listener);
      }
    }
    const remainingChildren = new Set(state.childListeners);
    state.childListeners.clear();
    for (const listener of priorChildren) {
      if (remainingChildren.has(listener) || suppressedChildren.has(listener)) {
        state.childListeners.add(listener);
      }
    }
    for (const listener of remainingChildren) {
      if (!state.childListeners.has(listener)) {
        state.childListeners.add(listener);
      }
    }
  }
}

function fanOutAdminListenersOnly(
  state: BackendState,
  children: ChildListeners,
  values: ValueListeners,
  paths: string[],
  priorsServer: ReturnType<ChildListeners['snapshotParents']>,
): void {
  const hasAdminValue = [...state.valueListeners].some((l) => l.admin);
  const hasAdminChild = [...state.childListeners].some((l) => l.admin);
  if (!hasAdminValue && !hasAdminChild) {
    return;
  }
  withFilteredListeners(
    state,
    (l) => l.admin === true,
    (l) => l.admin === true,
    () => fanOutAllListeners(state, children, values, paths, priorsServer),
  );
}

/**
 * Deliver optimistic updates only to non-admin client listeners whose `.read`
 * rules remain permitted on the optimistic tree. Admin listeners observe
 * committed server state only, and read-denied client listeners stay registered
 * in exact insertion order so server commit (`WritePlane.changed`) performs
 * canonical revocation (`listen ... deny` + `cancelCallback`, #M75a) without
 * prematurely revoking on a denied write (#M15).
 */
function fanOutClientListenersOptimistic(
  state: BackendState,
  children: ChildListeners,
  values: ValueListeners,
  paths: string[],
  priorsOptimistic: ReturnType<ChildListeners['snapshotParents']>,
): void {
  if (state.valueListeners.size === 0 && state.childListeners.size === 0) {
    return;
  }
  const deniedValues = new Set<ValueListener>();
  const deniedChildren = new Set<ChildListener>();
  if (state.activeRules !== null && paths.length > 0) {
    const canonicalChanged = paths.map((p) => joinPath(pathSegments(p)));
    const rulesRoot = state.activeRules.rules;
    const candidateValues = [...state.valueListeners].filter(
      (l) => !l.admin && listenerReadDependsOnPaths(rulesRoot, l.path, canonicalChanged),
    );
    const candidateChildren = [...state.childListeners].filter(
      (l) => !l.admin && listenerReadDependsOnPaths(rulesRoot, l.path, canonicalChanged),
    );
    if (candidateValues.length > 0 || candidateChildren.length > 0) {
      const mockData = state.rulesSnapshot();
      for (const listener of candidateValues) {
        const evaluation = state.rules.evaluate('read', listener.path, {
          auth: listener.auth,
          mockData,
          querySpec: listener.query,
        });
        if (evaluation.check !== 'allow') {
          deniedValues.add(listener);
        }
      }
      for (const listener of candidateChildren) {
        const evaluation = state.rules.evaluate('read', listener.path, {
          auth: listener.auth,
          mockData,
          querySpec: listener.spec,
        });
        if (evaluation.check !== 'allow') {
          deniedChildren.add(listener);
        }
      }
    }
  }
  withFilteredListeners(
    state,
    (l) => !l.admin && !deniedValues.has(l),
    (l) => !l.admin && !deniedChildren.has(l),
    () => fanOutAllListeners(state, children, values, paths, priorsOptimistic),
  );
}

export class PendingClientWrites {
  private readonly pending: PendingWriteEntry[] = [];
  private baseRoot: JsonValue | null = null;
  private basePriorities: Map<string, Exclude<Priority, null>> | null = null;

  constructor(
    private readonly state: BackendState,
    private readonly values: ValueListeners,
    private readonly children: ChildListeners,
    private readonly writes: WritePlane,
  ) {}

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  clear(): void {
    for (const entry of this.pending) {
      entry.cancelled = true;
    }
    this.pending.length = 0;
    this.baseRoot = null;
    this.basePriorities = null;
  }

  readCommitted<T>(fn: () => T): T {
    if (this.pending.length === 0 || this.basePriorities === null) {
      return fn();
    }
    const optimisticRoot = this.state.tree.peekRoot();
    const optimisticPriorities = this.state.priorities.snapshotMap();
    this.state.tree.restoreFrozenRoot(this.baseRoot);
    this.state.priorities.restoreMapSilently(this.basePriorities);
    try {
      return fn();
    } finally {
      this.state.tree.restoreFrozenRoot(optimisticRoot);
      this.state.priorities.restoreMapSilently(optimisticPriorities);
    }
  }

  runAgainstServer<T>(paths: readonly string[], fn: () => T): T {
    if (this.pending.length === 0 || this.basePriorities === null) {
      return fn();
    }
    const priorsOptimistic = this.children.snapshotParents();
    const savedBaseRoot = this.baseRoot;
    const savedBasePriorities = this.basePriorities;
    this.state.deferListenerFanOut = true;
    this.state.tree.restoreFrozenRoot(savedBaseRoot);
    this.state.priorities.restoreMapSilently(savedBasePriorities);
    const priorsServer = this.children.snapshotParents();
    const touched = [...paths];
    let outcome: T | undefined;
    let caught: unknown;
    let hasError = false;
    try {
      outcome = fn();
      this.baseRoot = this.state.tree.peekRoot();
      this.basePriorities = this.state.priorities.snapshotMap();
    } catch (err) {
      caught = err;
      hasError = true;
      this.state.tree.restoreFrozenRoot(savedBaseRoot);
      this.state.priorities.restoreMapSilently(savedBasePriorities);
    }
    this.state.deferListenerFanOut = false;
    if (!hasError && paths.length > 0) {
      fanOutAdminListenersOnly(
        this.state,
        this.children,
        this.values,
        Array.from(new Set(paths)),
        priorsServer,
      );
    }
    for (const rest of this.pending) {
      touched.push(...rest.applyOptimistic(this.state, rest.requestTime));
    }
    if (touched.length > 0) {
      fanOutClientListenersOptimistic(
        this.state,
        this.children,
        this.values,
        Array.from(new Set(touched)),
        priorsOptimistic,
      );
    }
    if (hasError) {
      throw caught;
    }
    return outcome as T;
  }

  enqueueSet(auth: AuthState, path: string, value: JsonValue): Promise<void> {
    return this.enqueue({
      requestTime: this.state.clock.now(),
      withProvenance: this.state.events.captureProvenanceWindow(),
      paths: [path],
      cancelled: false,
      applyOptimistic: (st, now) => applyOptimisticSet(st, path, value, null, false, now),
      commitServer: (w) => w.set(auth, path, value),
    });
  }

  enqueueSetWithPriority(
    auth: AuthState,
    path: string,
    value: JsonValue,
    priority: Priority,
  ): Promise<void> {
    return this.enqueue({
      requestTime: this.state.clock.now(),
      withProvenance: this.state.events.captureProvenanceWindow(),
      paths: [path],
      cancelled: false,
      applyOptimistic: (st, now) => applyOptimisticSet(st, path, value, priority, true, now),
      commitServer: (w) => w.setWithPriority(auth, path, value, priority),
    });
  }

  enqueueRemove(auth: AuthState, path: string): Promise<void> {
    return this.enqueue({
      requestTime: this.state.clock.now(),
      withProvenance: this.state.events.captureProvenanceWindow(),
      paths: [path],
      cancelled: false,
      applyOptimistic: (st, now) => applyOptimisticSet(st, path, null, null, false, now),
      commitServer: (w) => w.remove(auth, path),
    });
  }

  enqueueUpdate(auth: AuthState, path: string, patch: Record<string, JsonValue>): Promise<void> {
    return this.enqueue({
      requestTime: this.state.clock.now(),
      withProvenance: this.state.events.captureProvenanceWindow(),
      paths: [path],
      cancelled: false,
      applyOptimistic: (st, now) => applyOptimisticUpdate(st, path, patch, now),
      commitServer: (w) => w.update(auth, path, patch),
    });
  }

  enqueueSetPriority(auth: AuthState, path: string, priority: Priority): Promise<void> {
    return this.enqueue({
      requestTime: this.state.clock.now(),
      withProvenance: this.state.events.captureProvenanceWindow(),
      paths: [path],
      cancelled: false,
      applyOptimistic: (st, now) => applyOptimisticSetPriority(st, path, priority, now),
      commitServer: (w) => w.setPriority(auth, path, priority),
    });
  }

  private enqueue(entry: PendingWriteEntry): Promise<void> {
    const wasEmpty = this.pending.length === 0;
    if (wasEmpty) {
      this.baseRoot = this.state.tree.peekRoot();
      this.basePriorities = this.state.priorities.snapshotMap();
    }
    const beforeRoot = this.state.tree.peekRoot();
    const beforePriorities = this.state.priorities.snapshotMap();
    const priors = this.children.snapshotParents();
    let touchedPaths: string[];
    try {
      touchedPaths = entry.applyOptimistic(this.state, entry.requestTime);
    } catch (err) {
      this.state.tree.restoreFrozenRoot(beforeRoot);
      this.state.priorities.restoreMapSilently(beforePriorities);
      if (wasEmpty) {
        this.baseRoot = null;
        this.basePriorities = null;
      }
      return Promise.reject(err);
    }
    entry.paths = touchedPaths;
    this.pending.push(entry);
    if (touchedPaths.length > 0) {
      fanOutClientListenersOptimistic(this.state, this.children, this.values, touchedPaths, priors);
    }
    return Promise.resolve().then(() => this.commitEntry(entry));
  }

  private commitEntry(entry: PendingWriteEntry): void {
    if (entry.cancelled) {
      return;
    }
    const idx = this.pending.indexOf(entry);
    if (idx >= 0) {
      this.pending.splice(idx, 1);
    }
    if (this.basePriorities === null) {
      return;
    }
    const priorsOptimistic = this.children.snapshotParents();
    const savedBaseRoot = this.baseRoot;
    const savedBasePriorities = this.basePriorities;
    this.state.deferListenerFanOut = true;
    this.state.tree.restoreFrozenRoot(savedBaseRoot);
    this.state.priorities.restoreMapSilently(savedBasePriorities);
    const priorsServer = this.children.snapshotParents();

    let commitError: unknown;
    let hasError = false;
    this.state.pinnedNow = entry.requestTime;
    try {
      entry.withProvenance(() => entry.commitServer(this.writes));
      this.baseRoot = this.state.tree.peekRoot();
      this.basePriorities = this.state.priorities.snapshotMap();
    } catch (err) {
      commitError = err;
      hasError = true;
      this.state.tree.restoreFrozenRoot(savedBaseRoot);
      this.state.priorities.restoreMapSilently(savedBasePriorities);
    } finally {
      this.state.pinnedNow = null;
      this.state.deferListenerFanOut = false;
    }

    if (!hasError && entry.paths.length > 0) {
      fanOutAdminListenersOnly(
        this.state,
        this.children,
        this.values,
        Array.from(new Set(entry.paths)),
        priorsServer,
      );
    }

    const touched = [...entry.paths];
    if (this.pending.length > 0) {
      for (const rest of this.pending) {
        touched.push(...rest.applyOptimistic(this.state, rest.requestTime));
      }
    } else {
      this.baseRoot = null;
      this.basePriorities = null;
    }
    if (touched.length > 0) {
      fanOutClientListenersOptimistic(
        this.state,
        this.children,
        this.values,
        Array.from(new Set(touched)),
        priorsOptimistic,
      );
    }
    if (hasError) {
      throw commitError;
    }
  }
}
