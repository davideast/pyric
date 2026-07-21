import type { AuthState } from 'pyric/sandbox';
import type { RtdbBackend } from './sandbox/backend.js';
import type { JsonValue } from './sandbox/data-tree.js';
import { DisconnectOperationQueue, type DisconnectOperation } from './disconnect-operation-queue.js';

export class RtdbConnectionLifecycle {
  private readonly operations = new DisconnectOperationQueue();
  private draining: Promise<void> | null = null;
  private online = true;

  constructor(
    private readonly backend: RtdbBackend,
    private readonly auth: () => AuthState,
    private readonly admin: boolean,
  ) {}

  register(operation: DisconnectOperation): Promise<void> {
    try {
      if (!this.admin) {
        if (operation.kind === 'update') {
          this.backend.validateUpdate(this.auth(), operation.path, operation.values);
        } else {
          this.backend.validateSet(
            this.auth(),
            operation.path,
            operation.kind === 'remove' ? null : operation.value,
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
    this.operations.cancel(path);
    return Promise.resolve();
  }

  clear(): void {
    this.operations.clear();
    this.online = true;
  }

  goOffline(): void {
    if (!this.online) return;
    this.online = false;
    void this.drain().catch(() => undefined);
  }

  goOnline(): void {
    this.online = true;
  }

  drain(): Promise<void> {
    if (this.draining) return this.draining;
    const queued = this.operations.takeAll();
    this.draining = (async () => {
      const failures: unknown[] = [];
      for (const operation of queued) {
        try {
          if (operation.kind === 'update') {
            if (this.admin) {
              this.backend.adminUpdate(operation.path, operation.values as Record<string, JsonValue>);
            } else {
              this.backend.update(this.auth(), operation.path, operation.values as Record<string, JsonValue>);
            }
          } else {
            const value = operation.kind === 'remove' ? null : operation.value;
            if (
              operation.kind === 'set' &&
              operation.mergeAfterChildRegistration &&
              value !== null && typeof value === 'object' && !Array.isArray(value)
            ) {
              if (this.admin) {
                this.backend.adminUpdate(operation.path, value as Record<string, JsonValue>);
              } else {
                this.backend.update(this.auth(), operation.path, value as Record<string, JsonValue>);
              }
              continue;
            }
            if (this.admin) {
              this.backend.adminSet(operation.path, value as JsonValue);
            } else {
              this.backend.set(this.auth(), operation.path, value as JsonValue);
            }
          }
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Multiple onDisconnect operations failed');
    })().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }
}
