/**
 * `pyric-admin/machine-learning`: deferred service handle for `firebase-admin/machine-learning`.
 */
import type { PyricAdminApp } from '../app/index.js';
import {
  deferredAdminEntry,
  guardDeferredServiceApp,
  wireDeferredService,
} from '../deferred.js';

export { PyricDeferredApiError } from '../deferred.js';

export class MachineLearning {
  readonly #app: PyricAdminApp;

  /** @internal */
  constructor(...args: unknown[]) {
    this.#app = guardDeferredServiceApp('machine-learning', 'MachineLearning', args);
  }

  get app(): PyricAdminApp {
    return this.#app;
  }

  declare createModel: (...args: unknown[]) => Promise<never>;
  declare deleteModel: (...args: unknown[]) => Promise<never>;
  declare getModel: (...args: unknown[]) => Promise<never>;
  declare listModels: (...args: unknown[]) => Promise<never>;
  declare publishModel: (...args: unknown[]) => Promise<never>;
  declare unpublishModel: (...args: unknown[]) => Promise<never>;
  declare updateModel: (...args: unknown[]) => Promise<never>;
}

export const getMachineLearning: (app?: PyricAdminApp) => MachineLearning = wireDeferredService(
  MachineLearning,
  'machine-learning',
  'MachineLearning',
  {
    async: [
      'createModel',
      'deleteModel',
      'getModel',
      'listModels',
      'publishModel',
      'unpublishModel',
      'updateModel',
    ],
  },
);

export const { Model } = deferredAdminEntry('machine-learning');
