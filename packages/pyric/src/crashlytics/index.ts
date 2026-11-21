/**
 * Public `pyric/crashlytics` barrel mirroring `firebase/crashlytics`
 * (`@firebase/crashlytics@0.2.0` / `firebase@13.4.0` public preview).
 */
export {
  breadcrumbs,
  flush,
  getCrashlytics,
  log,
  recordError,
} from './client.js';

export type {
  AttributePrimitive,
  Attributes,
  AttributeValue,
  Crashlytics,
  CrashlyticsAttributes,
  CrashlyticsFeature,
  CrashlyticsOptions,
} from './types.js';
