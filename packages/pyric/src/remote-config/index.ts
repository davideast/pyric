/**
 * `pyric/remote-config` — a DEFERRED mirror of `firebase/remote-config`.
 *
 * Remote Config serves server-side parameter values with fetch/activate
 * caching semantics. Mirroring it needs a sandbox-side config store and a
 * model of the fetch throttle — buildable, not yet built.
 *
 * Every symbol below resolves and links so an app that swaps `firebase` for
 * `pyric` still loads; touching one throws `PyricDeferredApiError` naming this
 * subpath. See `../deferred/entry.ts` for the full rationale.
 *
 * The value list is the exact public runtime surface of `firebase/remote-config`
 * (Firebase Web SDK 12.13.0). Keep it in sync when this entry graduates to a
 * real mirror.
 */
import { deferredEntry, type DeferredApi } from '../deferred/entry.js';

export { PyricDeferredApiError } from '../deferred/entry.js';

export const {
  activate, ensureInitialized, fetchAndActivate, fetchConfig, getAll, getBoolean, getNumber,
  getRemoteConfig, getString, getValue, onConfigUpdate, setCustomSignals,
  setLogLevel,
} = deferredEntry('remote-config');

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
export type ConfigUpdate = DeferredApi;
export type ConfigUpdateObserver = DeferredApi;
export type CustomSignals = DeferredApi;
export type FetchResponse = DeferredApi;
export type FetchStatus = DeferredApi;
export type FetchType = DeferredApi;
export type FirebaseExperimentDescription = DeferredApi;
export type FirebaseRemoteConfigObject = DeferredApi;
export type LogLevel = DeferredApi;
export type RemoteConfig = DeferredApi;
export type RemoteConfigOptions = DeferredApi;
export type RemoteConfigSettings = DeferredApi;
export type Unsubscribe = DeferredApi;
export type Value = DeferredApi;
export type ValueSource = DeferredApi;
