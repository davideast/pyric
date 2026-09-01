/**
 * `pyric/app-check` — a DEFERRED mirror of `firebase/app-check`.
 *
 * App Check attests that a request comes from your app, via reCAPTCHA or a
 * custom attestation provider talking to Google infrastructure. The sandbox
 * has no attestation authority to model against, so the whole surface is
 * deferred.
 *
 * Every symbol below resolves and links so an app that swaps `firebase` for
 * `pyric` still loads; touching one throws `PyricDeferredApiError` naming this
 * subpath. See `../deferred/entry.ts` for the full rationale.
 *
 * The value list is the exact public runtime surface of `firebase/app-check`
 * (Firebase Web SDK 12.13.0). Keep it in sync when this entry graduates to a
 * real mirror.
 */
import { deferredEntry, type DeferredApi } from '../deferred/entry.js';

export { PyricDeferredApiError } from '../deferred/entry.js';

export const {
  CustomProvider, ReCaptchaEnterpriseProvider, ReCaptchaV3Provider, getLimitedUseToken,
  getToken, initializeAppCheck, onTokenChanged, setTokenAutoRefreshEnabled,
} = deferredEntry('app-check');

// Type declarations. Aliased to the deferred placeholder so a consumer's own
// annotations keep type-checking: every deferred call returns `never`, which is
// assignable to any of these. Names that Firebase exports as a CLASS appear both
// here and above — a class is a value and a type, and both meanings must survive
// the swap.
export type AppCheck = DeferredApi;
export type AppCheckOptions = DeferredApi;
export type AppCheckToken = DeferredApi;
export type AppCheckTokenListener = DeferredApi;
export type AppCheckTokenResult = DeferredApi;
export type CustomProvider = DeferredApi;
export type CustomProviderOptions = DeferredApi;
export type PartialObserver = DeferredApi;
export type ReCaptchaEnterpriseProvider = DeferredApi;
export type ReCaptchaV3Provider = DeferredApi;
export type Unsubscribe = DeferredApi;
