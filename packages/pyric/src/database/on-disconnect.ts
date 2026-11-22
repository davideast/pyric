import { markClientPathsWarm, updateTargetPaths } from './client-cache-state.js';
import { enqueueOfflineClientDisconnect, isClientOffline } from './offline-client-state.js';
import { isAdminFor, targetOf, type Target } from './routing.js';
import type { DatabaseReference } from './types.js';
import { validateWritablePath } from './writable-path.js';
import { errorPrefix, validatePriorityArg, validateUpdate, validateWrite } from './sandbox/normalize.js';

export class OnDisconnect {
  /** @internal Construct through {@link onDisconnect}. */
  constructor(
    private readonly _repo: Target,
    private readonly _path: string,
  ) {}

  cancel(): Promise<void> {
    if (isClientOffline(this._repo)) {
      return enqueueOfflineClientDisconnect(this._repo, () => this._repo.connection.cancel(this._path));
    }
    return this._repo.connection.cancel(this._path);
  }

  remove(): Promise<void> {
    validateWritablePath('OnDisconnect.remove', this._path);
    markClientPathsWarm(this._repo, [this._path]);
    if (isClientOffline(this._repo)) {
      return enqueueOfflineClientDisconnect(this._repo, () =>
        this._repo.connection.register({ kind: 'remove', path: this._path }),
      );
    }
    return this._repo.connection.register({ kind: 'remove', path: this._path });
  }

  set(value: unknown): Promise<void> {
    validateWritablePath('OnDisconnect.set', this._path);
    validateWrite(value, this._path, errorPrefix('OnDisconnect.set', 'value'), {
      checkInlinePriorities: !isAdminFor(this._repo),
    });
    markClientPathsWarm(this._repo, [this._path]);
    if (isClientOffline(this._repo)) {
      return enqueueOfflineClientDisconnect(this._repo, () =>
        this._repo.connection.register({ kind: 'set', path: this._path, value }),
      );
    }
    return this._repo.connection.register({ kind: 'set', path: this._path, value });
  }

  setWithPriority(value: unknown, priority: string | number | null): Promise<void> {
    validateWritablePath('OnDisconnect.setWithPriority', this._path);
    validateWrite(value, this._path, errorPrefix('OnDisconnect.setWithPriority', 'value'), {
      checkInlinePriorities: !isAdminFor(this._repo),
    });
    validatePriorityArg('OnDisconnect.setWithPriority', priority);
    markClientPathsWarm(this._repo, [this._path]);
    if (isClientOffline(this._repo)) {
      return enqueueOfflineClientDisconnect(this._repo, () =>
        this._repo.connection.register({ kind: 'set', path: this._path, value, priority }),
      );
    }
    return this._repo.connection.register({ kind: 'set', path: this._path, value, priority });
  }

  update(values: Record<string, unknown>): Promise<void> {
    validateWritablePath('OnDisconnect.update', this._path);
    validateUpdate(values, this._path, 'OnDisconnect.update', {
      checkInlinePriorities: !isAdminFor(this._repo),
    });
    markClientPathsWarm(this._repo, updateTargetPaths(this._path, values));
    if (isClientOffline(this._repo)) {
      return enqueueOfflineClientDisconnect(this._repo, () =>
        this._repo.connection.register({ kind: 'update', path: this._path, values }),
      );
    }
    return this._repo.connection.register({ kind: 'update', path: this._path, values });
  }
}

/**
 * Register a one-shot write for this Database client's next disconnect.
 * Registration checks rules immediately; execution checks them again.
 */
export function onDisconnect(r: DatabaseReference): OnDisconnect {
  const target = targetOf(r as unknown as object);
  return new OnDisconnect(target, r._path);
}
