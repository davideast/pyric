'use client';
/**
 * Sandbox mirror of `firebase/crashlytics/react`
 * (`@firebase/crashlytics@0.2.0` / `firebase@13.4.0`).
 *
 * Zero hard dependency on `react`: initializes the sandbox `Crashlytics`
 * handle (and its uncaught-error / breadcrumb listeners) for `firebaseApp`
 * and returns `null` so it works identically as `<FirebaseCrashlytics />`
 * in React JSX or when invoked directly in headless/unit tests.
 */
import type { FirebaseApp } from '../app/types.js';
import { getCrashlytics } from './client.js';
import { rememberBreadcrumbsOption } from './framework-routes.js';
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

/** Props accepted by {@link FirebaseCrashlytics}. */
export interface FirebaseCrashlyticsProps {
  firebaseApp: FirebaseApp;
  crashlyticsOptions?: CrashlyticsOptions;
}

/**
 * Registers Crashlytics uncaught-error listeners for a React application tree.
 */
export function FirebaseCrashlytics({
  firebaseApp,
  crashlyticsOptions,
}: FirebaseCrashlyticsProps): null {
  rememberBreadcrumbsOption(firebaseApp, crashlyticsOptions);
  getCrashlytics(firebaseApp, crashlyticsOptions);
  return null;
}
