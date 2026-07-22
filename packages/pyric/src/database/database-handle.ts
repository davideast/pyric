import type { FirebaseApp } from '../app/types.js';
import { TARGET_SYMBOL, type Target } from './routing.js';

/** Opaque RTDB handle. Routes via {@link TARGET_SYMBOL}. */
export class Database {
  readonly [TARGET_SYMBOL]!: Target;
  readonly app: FirebaseApp;
  readonly type = 'database';
  readonly _instanceStarted = false;
  readonly _repoInternal: undefined = undefined;

  constructor(target?: Target, app?: FirebaseApp) {
    if (target) this[TARGET_SYMBOL] = target;
    this.app = app as FirebaseApp;
  }

  get _repo(): undefined { return undefined; }
  get _root(): undefined { return undefined; }
  _delete(): Promise<void> { return Promise.resolve(); }
  _checkNotDeleted(_message?: string): void {}
}

/** Database handle returned by Firebase-shaped app overloads. */
export type AppDatabase = Database & { readonly app: FirebaseApp };
