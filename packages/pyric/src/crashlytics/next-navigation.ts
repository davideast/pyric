'use client';
/**
 * Sandbox mirror of `firebase/crashlytics/next-navigation`
 * (`@firebase/crashlytics@0.2.0` / `firebase@13.4.0`).
 *
 * Zero hard dependency on `next` or `react`: initializes the sandbox
 * `Crashlytics` handle for `firebaseApp`, formats parameterized Next.js App
 * Router route patterns, emits view-boundary breadcrumb logs when
 * `breadcrumbs()` is enabled, and returns `null` for JSX mounting.
 */
import type { FirebaseApp } from '../app/types.js';
import { getCrashlytics, log, recordError } from './client.js';
import {
  currentBrowserPathname,
  emitViewBoundaryIfChanged,
  formatParameterizedRoute,
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

/** Dynamic route parameter dictionary compatible with Next.js `useParams()`. */
export type NextNavigationParams = Record<string, string | string[] | undefined>;

/** Props accepted by {@link CrashlyticsRoutes} on `firebase/crashlytics/next-navigation`. */
export interface NextNavigationCrashlyticsRoutesProps {
  firebaseApp: FirebaseApp;
  crashlyticsOptions?: CrashlyticsOptions;
}

const inProcessDriver: CrashlyticsFrameworkDriver = {
  getCrashlytics,
  log,
  recordError,
};

/**
 * Constructs a parameterized route template for Next.js App Router by replacing
 * dynamic parameter values in `pathname` with `:param` / `:param*` placeholders.
 */
export function getParameterizedRoute(
  pathname: string | null,
  params: NextNavigationParams | null,
): string {
  return formatParameterizedRoute(pathname, params);
}

/**
 * Client-side routing component for Next.js App Router that initializes
 * Crashlytics and records navigation view-boundary breadcrumbs in the sandbox.
 */
export function CrashlyticsRoutes({
  firebaseApp,
  crashlyticsOptions,
}: NextNavigationCrashlyticsRoutesProps): null {
  const crashlytics = getCrashlytics(firebaseApp, crashlyticsOptions);
  const pathname = currentBrowserPathname();
  const pattern = getParameterizedRoute(pathname, null);
  emitViewBoundaryIfChanged(
    inProcessDriver,
    crashlytics,
    firebaseApp,
    pattern,
    crashlyticsOptions,
  );
  return null;
}
