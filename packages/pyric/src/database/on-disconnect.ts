import { targetOf, type Target } from './routing.js';
import type { DatabaseReference } from './database-types.js';

export class OnDisconnect {
  /** @internal Construct through {@link onDisconnect}. */
  constructor(
    private readonly _repo: Target,
    private readonly _path: string,
  ) {}

  cancel(): Promise<void> {
    return this._repo.connection.cancel(this._path);
  }

  remove(): Promise<void> {
    return this._repo.connection.register({ kind: 'remove', path: this._path });
  }

  set(value: unknown): Promise<void> {
    return this._repo.connection.register({ kind: 'set', path: this._path, value });
  }

  setWithPriority(value: unknown, priority: string | number | null): Promise<void> {
    return this._repo.connection.register({ kind: 'set', path: this._path, value, priority });
  }

  update(values: Record<string, unknown>): Promise<void> {
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


