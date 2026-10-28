/**
 * `pyric-admin/eventarc`: deferred service handle for `firebase-admin/eventarc`.
 */
import type { PyricAdminApp } from '../app/index.js';
import {
  deferredAdminEntry,
  guardDeferredServiceApp,
  wireDeferredService,
} from '../deferred.js';

export { PyricDeferredApiError } from '../deferred.js';

export class Eventarc {
  readonly #app: PyricAdminApp;

  /** @internal */
  constructor(...args: unknown[]) {
    this.#app = guardDeferredServiceApp('eventarc', 'Eventarc', args);
  }

  get app(): PyricAdminApp {
    return this.#app;
  }

  declare channel: (...args: unknown[]) => never;
}

export const getEventarc: (app?: PyricAdminApp) => Eventarc = wireDeferredService(
  Eventarc,
  'eventarc',
  'Eventarc',
  {
    sync: ['channel'],
  },
);

export const { Channel } = deferredAdminEntry('eventarc');
