/**
 * `pyric-admin/project-management`: deferred service handle for `firebase-admin/project-management`.
 */
import type { PyricAdminApp } from '../app/index.js';
import {
  deferredAdminEntry,
  guardDeferredServiceApp,
  wireDeferredService,
} from '../deferred.js';

export { PyricDeferredApiError } from '../deferred.js';

export class ProjectManagement {
  readonly #app: PyricAdminApp;

  /** @internal */
  constructor(...args: unknown[]) {
    this.#app = guardDeferredServiceApp('project-management', 'ProjectManagement', args);
  }

  get app(): PyricAdminApp {
    return this.#app;
  }

  declare androidApp: (...args: unknown[]) => never;
  declare iosApp: (...args: unknown[]) => never;
  declare shaCertificate: (...args: unknown[]) => never;
  declare createAndroidApp: (...args: unknown[]) => Promise<never>;
  declare createIosApp: (...args: unknown[]) => Promise<never>;
  declare listAndroidApps: (...args: unknown[]) => Promise<never>;
  declare listAppMetadata: (...args: unknown[]) => Promise<never>;
  declare listIosApps: (...args: unknown[]) => Promise<never>;
  declare setDisplayName: (...args: unknown[]) => Promise<never>;
}

export const getProjectManagement: (app?: PyricAdminApp) => ProjectManagement =
  wireDeferredService(ProjectManagement, 'project-management', 'ProjectManagement', {
    sync: ['androidApp', 'iosApp', 'shaCertificate'],
    async: [
      'createAndroidApp',
      'createIosApp',
      'listAndroidApps',
      'listAppMetadata',
      'listIosApps',
      'setDisplayName',
    ],
  });

export const {
  AndroidApp,
  AppPlatform,
  FirebaseProjectManagementError,
  IosApp,
  ShaCertificate,
} = deferredAdminEntry('project-management');
