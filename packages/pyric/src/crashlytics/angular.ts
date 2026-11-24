/**
 * Sandbox mirror of `firebase/crashlytics/angular`
 * (`@firebase/crashlytics@0.2.0` / `firebase@13.4.0`).
 *
 * Zero hard dependency on `@angular/core` or `@angular/router`: provides an
 * Angular-compatible `EnvironmentProviders` token while initializing the
 * sandbox `Crashlytics` handle, plus structural `FirebaseErrorHandler` and
 * router navigation helpers matching `@firebase/crashlytics/angular`.
 */
import type { FirebaseApp } from '../app/types.js';
import {
  getCrashlytics,
  log,
  recordError,
  validateCrashlyticsEndpointUrl,
} from './client.js';
import {
  emitViewBoundaryIfChanged,
  rememberBreadcrumbsOption,
  stripUrlDecorations,
  type CrashlyticsFrameworkDriver,
} from './framework-routes.js';
import type {
  AttributePrimitive,
  Attributes,
  AttributeValue,
  Crashlytics,
  CrashlyticsAttributes,
  CrashlyticsFeature,
  CrashlyticsOptions,
} from './types.js';

export type {
  AttributePrimitive,
  Attributes,
  AttributeValue,
  Crashlytics,
  CrashlyticsAttributes,
  CrashlyticsFeature,
  CrashlyticsOptions,
};

/** Structural Angular `EnvironmentProviders` brand compatible with `@angular/core` `ApplicationConfig.providers`. */
export interface CrashlyticsEnvironmentProviders {
  readonly ['\u0275brand']: 'EnvironmentProviders';
  readonly ['\u0275providers']?: unknown[];
}

/** Structural Angular `ErrorHandler` contract. */
export interface AngularErrorHandlerLike {
  handleError(error: unknown): void;
}

/** Structural Angular activated route snapshot node used by {@link getSafeRoutePath}. */
export interface AngularRouteSnapshotLike {
  readonly firstChild?: AngularRouteSnapshotLike | null;
  readonly pathFromRoot: ReadonlyArray<{
    readonly routeConfig?: { readonly path?: string } | null;
  }>;
}

/** Structural Angular router navigation event (`NavigationEnd` carries `urlAfterRedirects`). */
export interface AngularNavigationEventLike {
  readonly urlAfterRedirects?: unknown;
}

/** Structural Angular `Router` contract used by {@link getSafeRoutePath} and {@link setupCrashlyticsRoutes}. */
export interface AngularRouterLike {
  readonly url: string;
  readonly navigated?: boolean;
  readonly routerState: {
    readonly snapshot: {
      readonly root: AngularRouteSnapshotLike;
    };
  };
  readonly events: {
    subscribe(listener: (event: unknown) => void): { unsubscribe(): void };
  };
}

/** Structural Angular `DestroyRef` contract used by {@link setupCrashlyticsRoutes}. */
export interface AngularDestroyRefLike {
  onDestroy(callback: () => void): unknown;
}

const inProcessDriver: CrashlyticsFrameworkDriver = {
  getCrashlytics,
  log,
  recordError,
};

/**
 * Constructs the templated route path from an Angular router state snapshot
 * (for example `'/users/:id/posts'`).
 */
export function getSafeRoutePath(router: AngularRouterLike): string {
  let currentRoute = router.routerState.snapshot.root;
  while (currentRoute.firstChild) {
    currentRoute = currentRoute.firstChild;
  }
  const segments: string[] = [];
  for (const route of currentRoute.pathFromRoot) {
    const path = route.routeConfig?.path;
    if (typeof path === 'string' && path.length > 0) {
      segments.push(path);
    }
  }
  return `/${segments.join('/')}`;
}

/**
 * Extracts the raw path portion from a URL by stripping query parameters,
 * hash fragments, and Angular matrix parameters.
 */
export function getRawPath(url: string): string {
  return stripUrlDecorations(url);
}

/**
 * Custom Angular-compatible `ErrorHandler` that forwards uncaught errors to
 * the sandbox `Crashlytics` instance via `recordError()`.
 */
export class FirebaseErrorHandler implements AngularErrorHandlerLike {
  private readonly crashlytics: Crashlytics;

  constructor(app: FirebaseApp, crashlyticsOptions?: CrashlyticsOptions) {
    rememberBreadcrumbsOption(app, crashlyticsOptions);
    this.crashlytics = getCrashlytics(app, crashlyticsOptions);
  }

  handleError(error: unknown): void {
    recordError(this.crashlytics, error);
  }
}

function isNavigationEndEvent(
  event: unknown,
): event is { readonly urlAfterRedirects: string } {
  if (typeof event !== 'object' || event === null) {
    return false;
  }
  const candidate = event as AngularNavigationEventLike;
  return typeof candidate.urlAfterRedirects === 'string';
}

/**
 * Subscribes to Angular router navigation events and emits Crashlytics
 * view-boundary breadcrumbs when the raw path changes.
 */
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
  rememberBreadcrumbsOption(firebaseApp, crashlyticsOptions);

  let lastRawPath: string | undefined;
  if (router.navigated) {
    const initialPattern = getSafeRoutePath(router);
    lastRawPath = getRawPath(router.url);
    emitViewBoundaryIfChanged(
      inProcessDriver,
      crashlytics,
      firebaseApp,
      initialPattern,
      crashlyticsOptions,
      true,
    );
  }

  const subscription = router.events.subscribe((event: unknown) => {
    if (isNavigationEndEvent(event)) {
      const currentRawPath = getRawPath(event.urlAfterRedirects);
      if (currentRawPath !== lastRawPath) {
        lastRawPath = currentRawPath;
        const pattern = getSafeRoutePath(router);
        emitViewBoundaryIfChanged(
          inProcessDriver,
          crashlytics,
          firebaseApp,
          pattern,
          crashlyticsOptions,
          true,
        );
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

/**
 * Registers Firebase Crashlytics error handling and route tracking providers
 * for an Angular application.
 */
export function provideCrashlytics(
  getAppFn: () => FirebaseApp,
  options?: CrashlyticsOptions,
): CrashlyticsEnvironmentProviders {
  validateCrashlyticsEndpointUrl(options?.endpointUrl);
  try {
    const app = getAppFn();
    rememberBreadcrumbsOption(app, options);
    getCrashlytics(app, options);
  } catch (error) {
    if (!isMissingFirebaseAppError(error)) {
      throw error;
    }
    queueMicrotask(() => {
      try {
        const deferredApp = getAppFn();
        rememberBreadcrumbsOption(deferredApp, options);
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
