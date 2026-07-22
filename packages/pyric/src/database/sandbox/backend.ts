/**
 * RTDB sandbox lifecycle facade. Data-plane concepts live in focused
 * collaborators; this class preserves the target-facing interface used by the
 * modular SDK, persistence controller, replay system, and tests.
 */
import type { AuthState, Sandbox } from 'pyric/sandbox';
import { BackendState } from './backend-state.js';
import { ChildListeners } from './child-listeners.js';
import type { ChildListener, ValueListenerSnapshot } from './listener-types.js';
import { PersistenceState } from './persistence-state.js';
import { generatePushId } from './push-id.js';
import type { Priority, QueryRow, QuerySpec } from './query.js';
import { Transactions } from './transactions.js';
import { ValueListeners } from './value-listeners.js';
import { WritePlane } from './write-plane.js';
import type { JsonValue } from './data-tree.js';

export class RtdbBackend {
  private readonly state: BackendState;
  private readonly values: ValueListeners;
  private readonly children: ChildListeners;
  private readonly writes: WritePlane;
  private readonly transactions: Transactions;
  private readonly persistence: PersistenceState;

  constructor(sandbox?: Sandbox) {
    this.state = new BackendState(sandbox);
    this.values = new ValueListeners(this.state);
    this.children = new ChildListeners(this.state);
    this.writes = new WritePlane(this.state, this.values, this.children);
    this.transactions = new Transactions(this.state, this.values, this.children);
    this.persistence = new PersistenceState(this.state, this.values, this.children);
  }

  get connectionResetGeneration(): number { return this.state.resetGeneration; }
  /** Retained for the existing white-box history-release characterization. */
  private get transactionMutationHistory(): Array<{ version: number; paths: string[] }> {
    return this.state.mutations.entries;
  }
  invalidateConnectionQueues(): void { this.state.resetGeneration += 1; }

  getPriority(path: string): Priority { return this.state.priorities.get(path); }
  setData(seed: Record<string, JsonValue>): void { this.writes.setData(seed); }
  setRules(rules: { rules: Record<string, unknown> } | null): void { this.writes.setRules(rules); }
  getActiveRules(): { rules: Record<string, unknown> } | null { return this.writes.getActiveRules(); }
  snapshotState(): JsonValue { return this.writes.snapshotState(); }

  adminGet(path: string): JsonValue { return this.writes.adminGet(path); }
  adminGetQuery(path: string, spec: QuerySpec): QueryRow[] { return this.writes.adminGetQuery(path, spec); }
  adminSet(path: string, value: JsonValue): void { this.writes.adminSet(path, value); }
  adminSetWithPriority(path: string, value: JsonValue, priority: Priority): void {
    this.writes.adminSetWithPriority(path, value, priority);
  }
  adminUpdate(path: string, patch: Record<string, JsonValue>): void { this.writes.adminUpdate(path, patch); }
  adminRemove(path: string): void { this.writes.adminRemove(path); }
  adminSetPriority(path: string, priority: Priority): void { this.writes.adminSetPriority(path, priority); }

  get(auth: AuthState, path: string): JsonValue { return this.writes.get(auth, path); }
  getQuery(auth: AuthState, path: string, spec: QuerySpec): QueryRow[] {
    return this.writes.getQuery(auth, path, spec);
  }
  set(auth: AuthState, path: string, value: JsonValue): void { this.writes.set(auth, path, value); }
  setWithPriority(auth: AuthState, path: string, value: JsonValue, priority: Priority): void {
    this.writes.setWithPriority(auth, path, value, priority);
  }
  update(auth: AuthState, path: string, patch: Record<string, JsonValue>): void {
    this.writes.update(auth, path, patch);
  }
  remove(auth: AuthState, path: string): void { this.writes.remove(auth, path); }
  setPriority(auth: AuthState, path: string, priority: Priority): void {
    this.writes.setPriority(auth, path, priority);
  }
  validateSet(auth: AuthState, path: string, value: unknown): void {
    this.writes.validateSet(auth, path, value);
  }
  validateUpdate(auth: AuthState, path: string, patch: Record<string, unknown>): void {
    this.writes.validateUpdate(auth, path, patch);
  }

  onValue(
    auth: AuthState,
    path: string,
    cb: (snap: ValueListenerSnapshot) => void,
    query?: QuerySpec,
    cancelCallback?: (error: Error) => void,
    onCanceled?: () => void,
  ): () => void {
    return this.values.onValue(auth, path, cb, query, cancelCallback, onCanceled);
  }

  adminOnValue(
    path: string,
    cb: (snap: ValueListenerSnapshot) => void,
    query?: QuerySpec,
  ): () => void {
    return this.values.adminOnValue(path, cb, query);
  }

  runTransaction(
    auth: AuthState,
    path: string,
    updateFn: (current: JsonValue) => JsonValue | undefined,
    options?: { applyLocally?: boolean },
  ): { committed: boolean; val: JsonValue; key: string | null } {
    return this.transactions.run(auth, path, updateFn, options);
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

  off(
    path: string,
    eventType?: 'value' | ChildListener['event'],
    callback?: ((snap: unknown) => void) | unknown,
  ): void {
    if (eventType === undefined || eventType === 'value') this.values.off(path, callback);
    if (eventType !== 'value') this.children.off(path, eventType, callback);
  }

  exportTree(): JsonValue { return this.persistence.exportTree(); }
  exportPersistenceState(): JsonValue { return this.persistence.exportState(); }
  restoreTree(root: JsonValue): void { this.persistence.restore(root); }
  resetTree(): void { this.persistence.reset(); }
  subscribeWrites(onChange: () => void): () => void { return this.persistence.subscribe(onChange); }
  mintKey(): string { return generatePushId(); }
  listenerCount(): number { return this.values.count(); }
  childListenerCount(): number { return this.children.count(); }
}

export type { ChildListener, ValueListener } from './listener-types.js';
export { cloneJson, pathSegments, joinPath } from './data-tree.js';
export type { JsonValue } from './data-tree.js';
export type { QuerySpec, QueryRow } from './query.js';
