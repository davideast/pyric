/** The canonical `firebase/crashlytics` served mirror. */
import * as inPage from 'pyric/crashlytics';
import type {
  AttributePrimitive,
  Attributes,
  AttributeValue,
  Crashlytics,
  CrashlyticsAttributes,
  CrashlyticsFeature,
  CrashlyticsOptions,
} from 'pyric/crashlytics';
import { FirebaseError, getApp, type FirebaseApp } from 'pyric/app';
import { isSandboxAppDeleted, registerAppCleanup } from 'pyric/app/internal';
import {
  createTransportCrashlytics,
  validateCrashlyticsEndpointUrl,
} from 'pyric/crashlytics/internal';
import { createWorkerCrashlyticsTransport } from '../worker/client/crashlytics.js';
import { workerClientForApp } from './app-client.js';
import { rememberServedBreadcrumbs } from './crashlytics-framework-runtime.js';
import { useWorker } from './worker-runtime.js';

export type {
  AttributePrimitive,
  Attributes,
  AttributeValue,
  Crashlytics,
  CrashlyticsAttributes,
  CrashlyticsFeature,
  CrashlyticsOptions,
};

const workerCrashlyticsByApp = new WeakMap<FirebaseApp, Crashlytics>();

function resolveAppKey(app: FirebaseApp): string {
  const configuredAppId = app.options.appId;
  if (typeof configuredAppId === 'string' && configuredAppId.length > 0) {
    return configuredAppId;
  }
  if (app.name === '[DEFAULT]') {
    return 'default';
  }
  return app.name;
}

export const breadcrumbs = inPage.breadcrumbs;
export const log = inPage.log;
export const recordError = inPage.recordError;
export const flush = inPage.flush;

export function getCrashlytics(
  app?: FirebaseApp,
  options?: CrashlyticsOptions,
): Crashlytics {
  validateCrashlyticsEndpointUrl(options?.endpointUrl);
  const resolved = app ?? getApp();
  rememberServedBreadcrumbs(resolved, options);
  if (!useWorker) {
    return inPage.getCrashlytics(resolved, options);
  }
  if (isSandboxAppDeleted(resolved)) {
    throw new FirebaseError(
      'app/app-deleted',
      `Firebase: Firebase App named '${resolved.name}' already deleted (app/app-deleted).`,
    );
  }
  const existing = workerCrashlyticsByApp.get(resolved);
  if (existing !== undefined) {
    return existing;
  }
  const clientDb = workerClientForApp(resolved);
  const appId = resolveAppKey(resolved);
  const transport = createWorkerCrashlyticsTransport(clientDb, appId);
  const handle = createTransportCrashlytics(
    resolved,
    transport,
    options,
    (cleanup) => {
      registerAppCleanup(resolved, () => {
        workerCrashlyticsByApp.delete(resolved);
        cleanup();
      });
    },
  );
  workerCrashlyticsByApp.set(resolved, handle);
  return handle;
}
