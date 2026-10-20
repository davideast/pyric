/**
 * `pyric-admin/app-check`: deferred service handle for `firebase-admin/app-check`.
 */
import type { PyricAdminApp } from '../app/index.js';
import { guardDeferredServiceApp, wireDeferredService } from '../deferred.js';

export { PyricDeferredApiError } from '../deferred.js';

export class AppCheck {
  readonly #app: PyricAdminApp;

  /** @internal */
  constructor(...args: unknown[]) {
    this.#app = guardDeferredServiceApp('app-check', 'AppCheck', args);
  }

  get app(): PyricAdminApp {
    return this.#app;
  }

  declare createToken: (...args: unknown[]) => Promise<never>;
  declare verifyToken: (...args: unknown[]) => Promise<never>;
}

export const getAppCheck: (app?: PyricAdminApp) => AppCheck = wireDeferredService(
  AppCheck,
  'app-check',
  'AppCheck',
  {
    async: ['createToken', 'verifyToken'],
  },
);
