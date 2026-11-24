'use client';
/** The canonical `firebase/crashlytics/next-navigation` served mirror. */
import type { FirebaseApp } from 'pyric/app';
import {
  getParameterizedRoute,
  type AttributePrimitive,
  type Attributes,
  type AttributeValue,
  type Crashlytics,
  type CrashlyticsAttributes,
  type CrashlyticsFeature,
  type CrashlyticsOptions,
  type NextNavigationCrashlyticsRoutesProps,
  type NextNavigationParams,
} from 'pyric/crashlytics/next-navigation';
import { getCrashlytics, log } from './crashlytics.js';
import {
  currentServedPathname,
  emitServedViewBoundary,
} from './crashlytics-framework-runtime.js';

export { getParameterizedRoute };
export type {
  AttributePrimitive,
  Attributes,
  AttributeValue,
  Crashlytics,
  CrashlyticsAttributes,
  CrashlyticsFeature,
  CrashlyticsOptions,
  NextNavigationCrashlyticsRoutesProps,
  NextNavigationParams,
};

export function CrashlyticsRoutes({
  firebaseApp,
  crashlyticsOptions,
}: {
  firebaseApp: FirebaseApp;
  crashlyticsOptions?: CrashlyticsOptions;
}): null {
  const crashlytics = getCrashlytics(firebaseApp, crashlyticsOptions);
  const pattern = getParameterizedRoute(currentServedPathname(), null);
  emitServedViewBoundary(log, crashlytics, firebaseApp, pattern, crashlyticsOptions);
  return null;
}
