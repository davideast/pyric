/**
 * RTDB sandbox lifecycle facade. Data-plane concepts live in focused
 * collaborators; this class preserves the target-facing interface used by the
 * modular SDK, persistence controller, replay system, and tests.
 */
import type { AuthState, Sandbox } from 'pyric/sandbox';
import { BackendState } from './backend-state.js';
import { ChildListeners } from './child-listeners.js';
import {
  runClientTransactionAsync,
  type AsyncClientTransactionOptions,
  type ClientTransactionOutcome,
} from './client-transaction.js';
import type { ChildListener, ValueListener, ValueListenerSnapshot } from './listener-types.js';
import { PendingClientWrites } from './pending-client-writes.js';
import { PersistenceState } from './persistence-state.js';
import type { PriorityRecord } from './priority-state.js';
import { generatePushId } from './push-id.js';
import type { Priority, QueryReadResult, QueryRow, QuerySpec } from '../internal/query-projection.js';
import { Transactions } from './transactions.js';
import { ValueListeners } from './value-listeners.js';
import { WritePlane } from './write-plane.js';
import type { JsonValue } from './data-tree.js';
import type { ListenerAttribution } from '../../sandbox/attribution/listener-owners.js';
import { invalidInfoWrite, isInfoPath } from '../writable-path.js';

/**
 * Refuse a write that targets `/.info`, at `path` or through one of an
 * update's keys, as the database does for one that reaches it.
 */
function assertWritable(path: string, patch?: Record<string, unknown>): void {
  const targets = patch === undefined ? [path] : Object.keys(patch).map((key) => `${path}/${key}`);
  if (isInfoPath(path) || targets.some(isInfoPath)) throw invalidInfoWrite();
}

export class RtdbBackend {
  private readonly state: BackendState;
  private readonly values: ValueListeners;
  private readonly children: ChildListeners;
  private readonly writes: WritePlane;
  private readonly pendingWrites: PendingClientWrites;
  private readonly transactions: Transactions;
  private readonly persistence: PersistenceState;
  private dormant = false;

  /** `instance` is the instance's name, or `undefined` for the default instance. */
  constructor(sandbox?: Sandbox, instance?: string) {
    this.state = new BackendState(sandbox, instance);
    this.values = new ValueListeners(this.state);
    this.children = new ChildListeners(this.state);
    this.writes = new WritePlane(this.state, this.values, this.children);
    this.pendingWrites = new PendingClientWrites(this.state, this.values, this.children, this.writes);
    this.transactions = new Transactions(this.state, this.values, this.children, this.writes);
    this.persistence = new PersistenceState(this.state, this.values, this.children);
    this.state.writeSubscribers.add(() => {
      this.dormant = false;
    });
  }

  get connectionResetGeneration(): number { return this.state.resetGeneration; }
  /** Retained for the existing white-box history-release characterization. */
  private get transactionMutationHistory(): Array<{ version: number; paths: string[] }> {
    return this.state.mutations.entries;
  }
  onConnectionReset(listener: () => void): () => void {
    this.state.resetListeners.add(listener);
    return () => {
      this.state.resetListeners.delete(listener);
    };
  }
  invalidateConnectionQueues(): void {
    this.state.notifyConnectionReset();
  }

  getPriority(path: string): Priority { return this.state.priorities.get(path); }
  readPath(path: string): JsonValue { return this.state.tree.read(path); }
  snapshotPriorities(): Map<string, Exclude<Priority, null>> {
    return this.pendingWrites.readCommitted(() => this.state.priorities.snapshotMap());
  }
  setData(seed: Record<string, JsonValue>): void {
    this.pendingWrites.clear();
    this.writes.setData(seed);
  }
  setRules(rules: { rules: Record<string, unknown> } | null): void {
    this.pendingWrites.runAgainstServer([], () => this.writes.setRules(rules));
  }
  setDefaultPolicy(policy: 'allow' | 'deny'): void {
    this.pendingWrites.runAgainstServer([], () => this.writes.setDefaultPolicy(policy));
  }
  getActiveRules(): { rules: Record<string, unknown> } | null { return this.writes.getActiveRules(); }
  snapshotState(options?: { includePriorities?: boolean }): JsonValue {
    return this.pendingWrites.readCommitted(() => this.writes.snapshotState(options));
  }

  adminGet(path: string): JsonValue {
    return this.pendingWrites.readCommitted(() => this.writes.adminGet(path));
  }
  adminGetQuery(path: string, spec: QuerySpec): QueryReadResult {
    return this.pendingWrites.readCommitted(() => this.writes.adminGetQuery(path, spec));
  }
  adminSet(path: string, value: JsonValue): void {
    assertWritable(path);
    this.pendingWrites.runAgainstServer([path], () => this.writes.adminSet(path, value));
  }
  adminSetWithPriority(path: string, value: JsonValue, priority: Priority): void {
    assertWritable(path);
    this.pendingWrites.runAgainstServer([path], () => this.writes.adminSetWithPriority(path, value, priority));
  }
  adminUpdate(path: string, patch: Record<string, JsonValue>): void {
    assertWritable(path, patch);
    this.pendingWrites.runAgainstServer([path], () => this.writes.adminUpdate(path, patch));
  }
  adminRemove(path: string): void {
    assertWritable(path);
    this.pendingWrites.runAgainstServer([path], () => this.writes.adminRemove(path));
  }
  adminSetPriority(path: string, priority: Priority): void {
    assertWritable(path);
    this.pendingWrites.runAgainstServer([path], () => this.writes.adminSetPriority(path, priority));
  }

  get(auth: AuthState, path: string): JsonValue {
    return this.pendingWrites.readCommitted(() => this.writes.get(auth, path));
  }
  getQuery(auth: AuthState, path: string, spec: QuerySpec): QueryReadResult {
    return this.pendingWrites.readCommitted(() => this.writes.getQuery(auth, path, spec));
  }
  /**
   * The warning a listener on this query logs because the rules declare no
   * matching `.indexOn`, or `null` when no warning applies.
   */
  unspecifiedIndexWarning(path: string, spec: QuerySpec): string | null {
    return this.state.unspecifiedIndexWarning(path, spec);
  }
  set(auth: AuthState, path: string, value: JsonValue): void {
    assertWritable(path);
    this.pendingWrites.runAgainstServer([path], () => this.writes.set(auth, path, value));
  }
  setWithPriority(auth: AuthState, path: string, value: JsonValue, priority: Priority): void {
    assertWritable(path);
    this.pendingWrites.runAgainstServer([path], () => this.writes.setWithPriority(auth, path, value, priority));
  }
  update(auth: AuthState, path: string, patch: Record<string, JsonValue>): void {
    assertWritable(path, patch);
    this.pendingWrites.runAgainstServer([path], () => this.writes.update(auth, path, patch));
  }
  remove(auth: AuthState, path: string): void {
    assertWritable(path);
    this.pendingWrites.runAgainstServer([path], () => this.writes.remove(auth, path));
  }
  setPriority(auth: AuthState, path: string, priority: Priority): void {
    assertWritable(path);
    this.pendingWrites.runAgainstServer([path], () => this.writes.setPriority(auth, path, priority));
  }
  enqueueClientSet(auth: AuthState, path: string, value: JsonValue): Promise<void> {
    assertWritable(path);
    return this.pendingWrites.enqueueSet(auth, path, value);
  }
  enqueueClientSetWithPriority(auth: AuthState, path: string, value: JsonValue, priority: Priority): Promise<void> {
    assertWritable(path);
    return this.pendingWrites.enqueueSetWithPriority(auth, path, value, priority);
  }
  enqueueClientUpdate(auth: AuthState, path: string, patch: Record<string, JsonValue>): Promise<void> {
    assertWritable(path, patch);
    return this.pendingWrites.enqueueUpdate(auth, path, patch);
  }
  enqueueClientRemove(auth: AuthState, path: string): Promise<void> {
    assertWritable(path);
    return this.pendingWrites.enqueueRemove(auth, path);
  }
  enqueueClientSetPriority(auth: AuthState, path: string, priority: Priority): Promise<void> {
    assertWritable(path);
    return this.pendingWrites.enqueueSetPriority(auth, path, priority);
  }
  validateRead(auth: AuthState, path: string, spec?: QuerySpec): void {
    this.writes.validateRead(auth, path, spec);
  }
  validatePriority(auth: AuthState, path: string, priority: Priority): void {
    assertWritable(path);
    this.writes.validatePriority(auth, path, priority);
  }
  /** Decide and record an `onDisconnect` registration; see `WritePlane.registerDisconnect`. */
  registerDisconnect(auth: AuthState, operation: Parameters<WritePlane['registerDisconnect']>[1]): void {
    if (operation.kind === 'update') assertWritable(operation.path, operation.values);
    else assertWritable(operation.path);
    this.writes.registerDisconnect(auth, operation);
  }
  validateSet(auth: AuthState, path: string, value: unknown, priority: Priority = null): void {
    assertWritable(path);
    this.writes.validateSet(auth, path, value, priority);
  }
  validateUpdate(auth: AuthState, path: string, patch: Record<string, unknown>): void {
    assertWritable(path, patch);
    this.writes.validateUpdate(auth, path, patch);
  }

  onValue(
    auth: AuthState,
    path: string,
    cb: (snap: ValueListenerSnapshot) => void,
    query?: QuerySpec,
    cancelCallback?: (error: Error) => void,
    onCanceled?: () => void,
    attribution?: ListenerAttribution,
    event?: ValueListener['event'],
  ): () => void {
    return this.values.onValue(auth, path, cb, query, cancelCallback, onCanceled, attribution, event);
  }

  adminOnValue(
    path: string,
    cb: (snap: ValueListenerSnapshot) => void,
    query?: QuerySpec,
    event?: ValueListener['event'],
  ): () => void {
    return this.values.adminOnValue(path, cb, query, event);
  }

  runTransaction(
    auth: AuthState,
    path: string,
    updateFn: (current: JsonValue) => JsonValue | undefined,
    options?: { applyLocally?: boolean; admin?: boolean },
  ): { committed: boolean; val: JsonValue; key: string | null; priorities?: PriorityRecord } {
    assertWritable(path);
    return this.pendingWrites.runAgainstServer([path], () =>
      this.transactions.runClient(auth, path, updateFn, options));
  }

  runClientTransactionAsync(
    auth: AuthState,
    path: string,
    updateFn: (current: JsonValue) => JsonValue | undefined,
    options?: AsyncClientTransactionOptions,
  ): Promise<ClientTransactionOutcome> {
    try {
      assertWritable(path);
    } catch (err) {
      return Promise.reject(err);
    }
    return runClientTransactionAsync(
      {
        state: this.state,
        children: this.children,
        writes: this.writes,
        pendingWrites: this.pendingWrites,
      },
      auth,
      path,
      updateFn,
      options,
    );
  }

  onChild(
    auth: AuthState,
    event: ChildListener['event'],
    path: string,
    cb: ChildListener['cb'],
    spec?: QuerySpec,
    cancelCallback?: (error: Error) => void,
    onCanceled?: () => void,
  ): () => void {
    return this.children.onChild(auth, event, path, cb, spec, cancelCallback, onCanceled);
  }

  adminOnChild(
    event: ChildListener['event'],
    path: string,
    cb: ChildListener['cb'],
    spec?: QuerySpec,
  ): () => void {
    return this.children.adminOnChild(event, path, cb, spec);
  }

  off(
    path: string,
    eventType?: 'value' | ChildListener['event'],
    callback?: ((snap: unknown) => void) | unknown,
  ): void {
    if (eventType === undefined || eventType === 'value') this.values.off(path, callback);
    if (eventType !== 'value') this.children.off(path, eventType, callback);
  }

  exportTree(): JsonValue {
    return this.pendingWrites.readCommitted(() => this.persistence.exportTree());
  }
  exportPersistenceState(): JsonValue {
    return this.pendingWrites.readCommitted(() => this.persistence.exportState());
  }
  persistenceBackendState(): BackendState { return this.state; }
  hasDurableState(): boolean {
    if (this.state.activeRules !== null || this.state.priorities.size > 0) return true;
    const root = this.state.tree.peekRoot();
    if (root === null || root === undefined) return false;
    if (typeof root === 'object' && !Array.isArray(root)) {
      return Object.keys(root).length > 0;
    }
    return true;
  }
  markDormant(): void { this.dormant = true; }
  markActive(): void { this.dormant = false; }
  isDormant(): boolean { return this.dormant; }
  restoreTree(root: JsonValue): void {
    this.dormant = false;
    this.pendingWrites.clear();
    this.persistence.restore(root);
  }
  resetTree(preserveRules = false): void {
    this.pendingWrites.clear();
    this.persistence.reset(preserveRules);
  }
  subscribeWrites(onChange: () => void): () => void { return this.persistence.subscribe(onChange); }
  mintKey(): string { return generatePushId(this.state.clock.now()); }
  listenerCount(): number { return this.values.count(); }
  childListenerCount(): number { return this.children.count(); }
}

export type { ChildListener, ValueListener } from './listener-types.js';
export type { JsonValue } from './data-tree.js';
export type { QuerySpec } from './query.js';
