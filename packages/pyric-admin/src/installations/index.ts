/**
 * `pyric-admin/installations`: deferred service handle for `firebase-admin/installations`.
 */
import type { PyricAdminApp } from '../app/index.js';
import {
  deferredAdminEntry,
  guardDeferredServiceApp,
  wireDeferredService,
} from '../deferred.js';

export { PyricDeferredApiError } from '../deferred.js';

export class Installations {
  readonly #app: PyricAdminApp;

  /** @internal */
  constructor(...args: unknown[]) {
    this.#app = guardDeferredServiceApp('installations', 'Installations', args);
  }

  get app(): PyricAdminApp {
    return this.#app;
  }

  declare deleteInstallation: (...args: unknown[]) => Promise<never>;
}

export const getInstallations: (app?: PyricAdminApp) => Installations = wireDeferredService(
  Installations,
  'installations',
  'Installations',
  {
    async: ['deleteInstallation'],
  },
);

export const { FirebaseInstallationsError, InstallationsClientErrorCode } =
  deferredAdminEntry('installations');
