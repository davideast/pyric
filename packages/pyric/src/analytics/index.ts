/**
 * `pyric/analytics` — a DEFERRED mirror of `firebase/analytics`.
 *
 * Google Analytics for Firebase is a fire-and-forget telemetry pipe to
 * Google servers. There is no observable local behavior for the sandbox to
 * mirror, so it is deferred.
 *
 * Every symbol below resolves and links so an app that swaps `firebase` for
 * `pyric` still loads; touching one throws `PyricDeferredApiError` naming this
 * subpath. See `../deferred/entry.ts` for the full rationale.
 *
 * The value list is the exact public runtime surface of `firebase/analytics`
 * (Firebase Web SDK 12.13.0). Keep it in sync when this entry graduates to a
 * real mirror.
 */
import { deferredEntry, type DeferredApi } from '../deferred/entry.js';

export { PyricDeferredApiError } from '../deferred/entry.js';

export const {
  getAnalytics, getGoogleAnalyticsClientId, initializeAnalytics, logEvent,
  setAnalyticsCollectionEnabled, setConsent, setCurrentScreen, setDefaultEventParameters,
  setUserId, setUserProperties, settings,
} = deferredEntry('analytics');

/**
 * The one deferred symbol that answers instead of throwing: the real SDK
 * resolves a boolean, and a deferred entry IS unsupported, so the standard
 * `isSupported().then(ok => ok && get…(app))` guard must run — not crash.
 */
export const isSupported = async (): Promise<boolean> => false;


// Type declarations. Aliased to the deferred placeholder so a consumer's own
// annotations keep type-checking: every deferred call returns `never`, which is
// assignable to any of these. Names that Firebase exports as a CLASS appear both
// here and above — a class is a value and a type, and both meanings must survive
// the swap.
export type Analytics = DeferredApi;
export type AnalyticsCallOptions = DeferredApi;
export type AnalyticsSettings = DeferredApi;
export type ConsentSettings = DeferredApi;
export type ConsentStatusString = DeferredApi;
export type ControlParams = DeferredApi;
export type Currency = DeferredApi;
export type CustomEventName = DeferredApi;
export type CustomParams = DeferredApi;
export type EventNameString = DeferredApi;
export type EventParams = DeferredApi;
export type GtagConfigParams = DeferredApi;
export type Item = DeferredApi;
export type Promotion = DeferredApi;
export type SettingsOptions = DeferredApi;
