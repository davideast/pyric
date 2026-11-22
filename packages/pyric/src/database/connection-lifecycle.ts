import type { AuthState } from 'pyric/sandbox';
import { ref } from './references.js';
import { authFor, isAdminFor, targetOf } from './routing.js';
import type { RtdbBackend } from './sandbox/backend.js';
import type { JsonValue } from './sandbox/data-tree.js';
import { errorPrefix, validatePriorityArg, validateUpdate, validateWrite } from './sandbox/normalize.js';
import { DisconnectOperationQueue, type DisconnectOperation } from './disconnect-operation-queue.js';
import type { Database } from './types.js';

/**
 * Apply one queued `onDisconnect` operation directly against the server-side
 * backend (never through the optimistic client write queue), so a disconnect
 * write denied by rules mutates nothing and emits no speculative listener
 * events.
 */
function executeDisconnectOperationOnBackend(
  backend: RtdbBackend,
  auth: AuthState,
  admin: boolean,
  operation: DisconnectOperation,
): void {
  if (operation.kind === 'update') {
    if (admin) {
      backend.adminUpdate(operation.path, operation.values as Record<string, JsonValue>);
    } else {
      backend.update(auth, operation.path, operation.values as Record<string, JsonValue>);
    }
    return;
  }
  if (operation.kind === 'remove') {
    if (admin) {
      backend.adminRemove(operation.path);
    } else {
      backend.remove(auth, operation.path);
    }
    return;
  }
  const priority = operation.priority;
  if (admin) {
    if (priority !== undefined) {
      backend.adminSetWithPriority(operation.path, operation.value as JsonValue, priority);
    } else {
      backend.adminSet(operation.path, operation.value as JsonValue);
    }
    return;
  }
  if (priority !== undefined) {
    backend.setWithPriority(auth, operation.path, operation.value as JsonValue, priority);
  } else {
    backend.set(auth, operation.path, operation.value as JsonValue);
  }
}

/**
 * Execute one queued `onDisconnect` operation against `db`'s server-side
 * backend using `db`'s resolved auth and admin state, matching in-page
 * {@link RtdbConnectionLifecycle.drain}.
 */
export function executeDisconnectOperation(
  db: Database,
  operation: DisconnectOperation,
): void {
  const target = targetOf(db as unknown as object);
  const path = ref(db, operation.path)._path;
  executeDisconnectOperationOnBackend(
    target.backend,
    authFor(target),
    isAdminFor(target),
    { ...operation, path },
  );
}

export class RtdbConnectionLifecycle {
  private readonly operations = new DisconnectOperationQueue();
  private draining: Promise<void> | null = null;
  private online = true;
  private readonly connectionListeners = new Set<(online: boolean) => void>();
  private stopResetListener: (() => void) | null = null;
  private resetGeneration: number;

  constructor(
    private readonly backend: RtdbBackend,
    private readonly auth: () => AuthState,
    private readonly admin: boolean | (() => boolean),
  ) {
    this.resetGeneration = backend.connectionResetGeneration;
  }

  private isAdmin(): boolean {
    if (typeof this.admin === 'function') {
      return this.admin();
    }
    return this.admin;
  }

  private synchronizeReset(): void {
    const isCurrentGeneration = this.resetGeneration === this.backend.connectionResetGeneration;
    if (isCurrentGeneration) return;
    this.resetGeneration = this.backend.connectionResetGeneration;
    this.operations.clear();
    this.setOnline(true);
  }

  register(operation: DisconnectOperation): Promise<void> {
    this.synchronizeReset();
    try {
      if (operation.kind === 'update') {
        validateUpdate(operation.values, operation.path, 'OnDisconnect.update', {
          checkServerValues: true,
        });
      } else if (operation.kind === 'set') {
        validateWrite(operation.value, operation.path, errorPrefix('OnDisconnect.set', 'value'), {
          checkServerValues: true,
        });
        if (operation.priority !== undefined) {
          validatePriorityArg('OnDisconnect.setWithPriority', operation.priority, {
            checkServerValues: true,
          });
        }
      }
      const requiresRules = !this.isAdmin();
      if (requiresRules) {
        // Decided when registered, as production decides it, and recorded as
        // an `onDisconnect.*` operation so a captured session carries it.
        if (operation.kind === 'update') {
          this.backend.registerDisconnect(this.auth(), { kind: 'update', path: operation.path, values: operation.values });
        } else if (operation.kind === 'remove') {
          this.backend.registerDisconnect(this.auth(), { kind: 'remove', path: operation.path });
        } else {
          this.backend.registerDisconnect(this.auth(), {
            kind: 'set', path: operation.path, value: operation.value, priority: operation.priority ?? null,
          });
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
    this.setOnline(true);
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
    if (this.connectionListeners.size === 0 && this.stopResetListener === null) {
      this.stopResetListener = this.backend.onConnectionReset(() => {
        this.synchronizeReset();
      });
    }
    this.connectionListeners.add(next);
    next(this.online);
    return () => {
      this.connectionListeners.delete(next);
      if (this.connectionListeners.size === 0 && this.stopResetListener !== null) {
        this.stopResetListener();
        this.stopResetListener = null;
      }
    };
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
          executeDisconnectOperationOnBackend(
            this.backend,
            this.auth(),
            this.isAdmin(),
            operation,
          );
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
