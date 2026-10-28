/**
 * `pyric-admin/extensions`: deferred service handle for `firebase-admin/extensions`.
 */
import type { PyricAdminApp } from '../app/index.js';
import {
  deferredAdminEntry,
  guardDeferredServiceApp,
  wireDeferredService,
} from '../deferred.js';

export { PyricDeferredApiError } from '../deferred.js';

export class Extensions {
  readonly #app: PyricAdminApp;

  /** @internal */
  constructor(...args: unknown[]) {
    this.#app = guardDeferredServiceApp('extensions', 'Extensions', args);
  }

  get app(): PyricAdminApp {
    return this.#app;
  }

  declare runtime: (...args: unknown[]) => never;
}

export const getExtensions: (app?: PyricAdminApp) => Extensions = wireDeferredService(
  Extensions,
  'extensions',
  'Extensions',
  {
    sync: ['runtime'],
  },
);

export const { Runtime } = deferredAdminEntry('extensions');
