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
  assertMatchingCrashlyticsOptions,
  createTransportCrashlytics,
  validateCrashlyticsEndpointUrl,
} from 'pyric/crashlytics/internal';
import { createWorkerCrashlyticsTransport } from '../worker/client/crashlytics.js';
import { workerClientForApp } from './app-client.js';
import {
  deleteServedWorkerCrashlytics,
  getServedWorkerCrashlytics,
  rememberServedBreadcrumbs,
  setServedWorkerCrashlytics,
} from './crashlytics-framework-runtime.js';
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
  const existing = getServedWorkerCrashlytics(resolved);
  if (existing !== undefined) {
    assertMatchingCrashlyticsOptions(existing, options);
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
        deleteServedWorkerCrashlytics(resolved);
        cleanup();
      });
    },
  );
  setServedWorkerCrashlytics(resolved, handle);
  return handle;
}
