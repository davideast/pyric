/** The canonical `firebase/crashlytics/angular` served mirror. */
import type { FirebaseApp } from 'pyric/app';
import { validateCrashlyticsEndpointUrl } from 'pyric/crashlytics/internal';
import {
  getRawPath,
  getSafeRoutePath,
  type AngularDestroyRefLike,
  type AngularErrorHandlerLike,
  type AngularNavigationEventLike,
  type AngularRouteSnapshotLike,
  type AngularRouterLike,
  type AttributePrimitive,
  type Attributes,
  type AttributeValue,
  type Crashlytics,
  type CrashlyticsAttributes,
  type CrashlyticsEnvironmentProviders,
  type CrashlyticsFeature,
  type CrashlyticsOptions,
} from 'pyric/crashlytics/angular';
import { getCrashlytics, log, recordError } from './crashlytics.js';
import {
  emitServedViewBoundary,
  rememberServedBreadcrumbs,
} from './crashlytics-framework-runtime.js';

export { getRawPath, getSafeRoutePath };
export type {
  AngularDestroyRefLike,
  AngularErrorHandlerLike,
  AngularNavigationEventLike,
  AngularRouteSnapshotLike,
  AngularRouterLike,
  AttributePrimitive,
  Attributes,
  AttributeValue,
  Crashlytics,
  CrashlyticsAttributes,
  CrashlyticsEnvironmentProviders,
  CrashlyticsFeature,
  CrashlyticsOptions,
};

export class FirebaseErrorHandler implements AngularErrorHandlerLike {
  private readonly crashlytics: Crashlytics;

  constructor(app: FirebaseApp, crashlyticsOptions?: CrashlyticsOptions) {
    rememberServedBreadcrumbs(app, crashlyticsOptions);
    this.crashlytics = getCrashlytics(app, crashlyticsOptions);
  }

  handleError(error: unknown): void {
    recordError(this.crashlytics, error);
  }
}

function isNavigationEnd(
  event: unknown,
): event is { readonly urlAfterRedirects: string } {
  if (typeof event !== 'object' || event === null) {
    return false;
  }
  const candidate = event as AngularNavigationEventLike;
  return typeof candidate.urlAfterRedirects === 'string';
}

export function setupCrashlyticsRoutes({
  firebaseApp,
  router,
  destroyRef,
  crashlyticsOptions,
}: {
  firebaseApp: FirebaseApp;
  router: AngularRouterLike;
  destroyRef: AngularDestroyRefLike;
  crashlyticsOptions?: CrashlyticsOptions;
}): void {
  const crashlytics = getCrashlytics(firebaseApp, crashlyticsOptions);
  rememberServedBreadcrumbs(firebaseApp, crashlyticsOptions);

  let lastRawPath: string | undefined;
  if (router.navigated) {
    const initialPattern = getSafeRoutePath(router);
    lastRawPath = getRawPath(router.url);
    emitServedViewBoundary(log, crashlytics, firebaseApp, initialPattern, crashlyticsOptions, true);
  }

  const subscription = router.events.subscribe((event: unknown) => {
    if (isNavigationEnd(event)) {
      const currentRawPath = getRawPath(event.urlAfterRedirects);
      if (currentRawPath !== lastRawPath) {
        lastRawPath = currentRawPath;
        const pattern = getSafeRoutePath(router);
        emitServedViewBoundary(log, crashlytics, firebaseApp, pattern, crashlyticsOptions, true);
      }
    }
  });

  destroyRef.onDestroy(() => {
    subscription.unsubscribe();
  });
}

function isMissingFirebaseAppError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  return (error as { code?: unknown }).code === 'app/no-app';
}

export function provideCrashlytics(
  getAppFn: () => FirebaseApp,
  options?: CrashlyticsOptions,
): CrashlyticsEnvironmentProviders {
  validateCrashlyticsEndpointUrl(options?.endpointUrl);
  try {
    const app = getAppFn();
    rememberServedBreadcrumbs(app, options);
    getCrashlytics(app, options);
  } catch (error) {
    if (!isMissingFirebaseAppError(error)) {
      throw error;
    }
    queueMicrotask(() => {
      try {
        const deferredApp = getAppFn();
        rememberServedBreadcrumbs(deferredApp, options);
        getCrashlytics(deferredApp, options);
      } catch (deferredError) {
        if (!isMissingFirebaseAppError(deferredError)) {
          throw deferredError;
        }
      }
    });
  }
  const providers: unknown[] = [];
  const envProviders: Record<string, unknown> = {};
  envProviders['\u0275brand'] = 'EnvironmentProviders';
  envProviders['\u0275providers'] = providers;
  return envProviders as unknown as CrashlyticsEnvironmentProviders;
}
