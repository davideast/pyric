'use client';
/** The canonical `firebase/crashlytics/react` served mirror. */
import type { FirebaseApp } from 'pyric/app';
import type {
  AttributePrimitive,
  Attributes,
  AttributeValue,
  Crashlytics,
  CrashlyticsAttributes,
  CrashlyticsFeature,
  CrashlyticsOptions,
  FirebaseCrashlyticsProps,
} from 'pyric/crashlytics/react';
import { getCrashlytics } from './crashlytics.js';
import { rememberServedBreadcrumbs } from './crashlytics-framework-runtime.js';

export type {
  AttributePrimitive,
  Attributes,
  AttributeValue,
  Crashlytics,
  CrashlyticsAttributes,
  CrashlyticsFeature,
  CrashlyticsOptions,
  FirebaseCrashlyticsProps,
};

export function FirebaseCrashlytics({
  firebaseApp,
  crashlyticsOptions,
}: {
  firebaseApp: FirebaseApp;
  crashlyticsOptions?: CrashlyticsOptions;
}): null {
  rememberServedBreadcrumbs(firebaseApp, crashlyticsOptions);
  getCrashlytics(firebaseApp, crashlyticsOptions);
  return null;
}
