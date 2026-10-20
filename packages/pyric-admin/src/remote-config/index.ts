/**
 * `pyric-admin/remote-config`: deferred service handle for `firebase-admin/remote-config`.
 */
import type { PyricAdminApp } from '../app/index.js';
import {
  deferredAdminEntry,
  guardDeferredServiceApp,
  wireDeferredService,
} from '../deferred.js';

export { PyricDeferredApiError } from '../deferred.js';

export class RemoteConfig {
  readonly #app: PyricAdminApp;

  /** @internal */
  constructor(...args: unknown[]) {
    this.#app = guardDeferredServiceApp('remote-config', 'RemoteConfig', args);
  }

  get app(): PyricAdminApp {
    return this.#app;
  }

  declare createTemplateFromJSON: (...args: unknown[]) => never;
  declare initServerTemplate: (...args: unknown[]) => never;
  declare getServerTemplate: (...args: unknown[]) => Promise<never>;
  declare getTemplate: (...args: unknown[]) => Promise<never>;
  declare getTemplateAtVersion: (...args: unknown[]) => Promise<never>;
  declare listVersions: (...args: unknown[]) => Promise<never>;
  declare publishTemplate: (...args: unknown[]) => Promise<never>;
  declare rollback: (...args: unknown[]) => Promise<never>;
  declare validateTemplate: (...args: unknown[]) => Promise<never>;
}

export const getRemoteConfig: (app?: PyricAdminApp) => RemoteConfig = wireDeferredService(
  RemoteConfig,
  'remote-config',
  'RemoteConfig',
  {
    sync: ['createTemplateFromJSON', 'initServerTemplate'],
    async: [
      'getServerTemplate',
      'getTemplate',
      'getTemplateAtVersion',
      'listVersions',
      'publishTemplate',
      'rollback',
      'validateTemplate',
    ],
  },
);

export const {
  CustomSignalOperator,
  PercentConditionOperator,
  RemoteConfigFetchResponse,
} = deferredAdminEntry('remote-config');
