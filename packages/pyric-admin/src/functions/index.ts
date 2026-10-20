/**
 * `pyric-admin/functions`: deferred service handle for `firebase-admin/functions`.
 */
import type { PyricAdminApp } from '../app/index.js';
import {
  deferredAdminEntry,
  guardDeferredServiceApp,
  wireDeferredService,
} from '../deferred.js';

export { PyricDeferredApiError } from '../deferred.js';

export class Functions {
  readonly #app: PyricAdminApp;

  /** @internal */
  constructor(...args: unknown[]) {
    this.#app = guardDeferredServiceApp('functions', 'Functions', args);
  }

  get app(): PyricAdminApp {
    return this.#app;
  }

  declare taskQueue: (...args: unknown[]) => never;
}

export const getFunctions: (app?: PyricAdminApp) => Functions = wireDeferredService(
  Functions,
  'functions',
  'Functions',
  {
    sync: ['taskQueue'],
  },
);

export const { TaskQueue } = deferredAdminEntry('functions');
