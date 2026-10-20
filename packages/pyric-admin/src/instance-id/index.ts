/**
 * `pyric-admin/instance-id`: deferred service handle for `firebase-admin/instance-id`.
 */
import type { PyricAdminApp } from '../app/index.js';
import {
  deferredAdminEntry,
  guardDeferredServiceApp,
  wireDeferredService,
} from '../deferred.js';

export { PyricDeferredApiError } from '../deferred.js';

export class InstanceId {
  readonly #app: PyricAdminApp;

  /** @internal */
  constructor(...args: unknown[]) {
    this.#app = guardDeferredServiceApp('instance-id', 'InstanceId', args);
  }

  get app(): PyricAdminApp {
    return this.#app;
  }

  declare deleteInstanceId: (...args: unknown[]) => Promise<never>;
}

export const getInstanceId: (app?: PyricAdminApp) => InstanceId = wireDeferredService(
  InstanceId,
  'instance-id',
  'InstanceId',
  {
    async: ['deleteInstanceId'],
  },
);

export const { FirebaseInstanceIdError, InstanceIdClientErrorCode } =
  deferredAdminEntry('instance-id');
