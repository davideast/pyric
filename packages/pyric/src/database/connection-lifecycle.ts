import type { AuthState } from 'pyric/sandbox';
import type { RtdbBackend } from './sandbox/backend.js';
import type { JsonValue } from './sandbox/data-tree.js';
import { DisconnectOperationQueue, type DisconnectOperation } from './disconnect-operation-queue.js';

export class RtdbConnectionLifecycle {
  private readonly operations = new DisconnectOperationQueue();
  private draining: Promise<void> | null = null;
  private online = true;
  private readonly connectionListeners = new Set<(online: boolean) => void>();
  private resetGeneration: number;

  constructor(
    private readonly backend: RtdbBackend,
    private readonly auth: () => AuthState,
    private readonly admin: boolean,
  ) {
    this.resetGeneration = backend.connectionResetGeneration;
  }

  private synchronizeReset(): void {
    const isCurrentGeneration = this.resetGeneration === this.backend.connectionResetGeneration;
    if (isCurrentGeneration) return;
    this.operations.clear();
    this.online = true;
    this.resetGeneration = this.backend.connectionResetGeneration;
  }

  register(operation: DisconnectOperation): Promise<void> {
    this.synchronizeReset();
    try {
      const requiresRules = !this.admin;
      if (requiresRules) {
        const isUpdate = operation.kind === 'update';
        if (isUpdate) {
          this.backend.validateUpdate(this.auth(), operation.path, operation.values);
        } else {
          const isRemove = operation.kind === 'remove';
          this.backend.validateSet(
            this.auth(),
            operation.path,
            isRemove ? null : operation.value,
          );
        }
      }
      this.operations.set(operation);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  cancel(path: string): Promise<void> {
    this.synchronizeReset();
    this.operations.cancel(path);
    return Promise.resolve();
  }

  clear(): void {
    this.operations.clear();
    this.online = true;
  }

  goOffline(): void {
    this.synchronizeReset();
    const isOffline = !this.online;
    if (isOffline) return;
    this.setOnline(false);
    void this.drain().catch(() => undefined);
  }

  goOnline(): void {
    this.synchronizeReset();
    this.setOnline(true);
  }

  observeConnection(next: (online: boolean) => void): () => void {
    this.synchronizeReset();
    this.connectionListeners.add(next);
    next(this.online);
    return () => { this.connectionListeners.delete(next); };
  }

  private setOnline(online: boolean): void {
    const isUnchanged = this.online === online;
    if (isUnchanged) return;
    this.online = online;
    for (const listener of [...this.connectionListeners]) listener(online);
  }

  drain(): Promise<void> {
    this.synchronizeReset();
    const currentDrain = this.draining;
    const isDraining = currentDrain !== null;
    if (isDraining) return currentDrain;
    const queued = this.operations.takeAll();
    this.draining = (async () => {
      const failures: unknown[] = [];
      for (const operation of queued) {
        try {
          const isUpdate = operation.kind === 'update';
          const isAdmin = this.admin;
          if (isUpdate) {
            if (isAdmin) {
              this.backend.adminUpdate(operation.path, operation.values as Record<string, JsonValue>);
            } else {
              this.backend.update(this.auth(), operation.path, operation.values as Record<string, JsonValue>);
            }
          } else {
            const isRemove = operation.kind === 'remove';
            const value = isRemove ? null : operation.value;
            const isSet = operation.kind === 'set';
            const mergesAfterChildRegistration = isSet && operation.mergeAfterChildRegistration === true;
            const hasObjectValue = value !== null && typeof value === 'object';
            const mergesObjectChildren = mergesAfterChildRegistration && hasObjectValue && !Array.isArray(value);
            if (mergesObjectChildren) {
              if (isAdmin) {
                this.backend.adminUpdate(operation.path, value as Record<string, JsonValue>);
              } else {
                this.backend.update(this.auth(), operation.path, value as Record<string, JsonValue>);
              }
              continue;
            }
            const priority = isSet ? operation.priority : undefined;
            const hasPriority = priority !== undefined;
            if (isAdmin) {
              if (hasPriority) {
                this.backend.adminSetWithPriority(operation.path, value as JsonValue, priority);
              } else {
                this.backend.adminSet(operation.path, value as JsonValue);
              }
            } else {
              if (hasPriority) {
                this.backend.setWithPriority(this.auth(), operation.path, value as JsonValue, priority);
              } else {
                this.backend.set(this.auth(), operation.path, value as JsonValue);
              }
            }
          }
        } catch (error) {
          failures.push(error);
        }
      }
      const hasOneFailure = failures.length === 1;
      if (hasOneFailure) throw failures[0];
      const hasMultipleFailures = failures.length > 1;
      if (hasMultipleFailures) throw new AggregateError(failures, 'Multiple onDisconnect operations failed');
    })().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }
}
