/**
 * `pyric/functions` — a DEFERRED mirror of `firebase/functions`.
 *
 * Callable Cloud Functions dispatch to deployed server code. Mirroring this
 * means running the user’s functions, which is the emulator’s job, not the
 * in-process sandbox’s — deferred pending a decision on the function-host
 * seam.
 *
 * Every symbol below resolves and links so an app that swaps `firebase` for
 * `pyric` still loads; touching one throws `PyricDeferredApiError` naming this
 * subpath. See `../deferred/entry.ts` for the full rationale.
 *
 * The value list is the exact public runtime surface of `firebase/functions`
 * (Firebase Web SDK 12.13.0). Keep it in sync when this entry graduates to a
 * real mirror.
 */
import { deferredEntry, type DeferredApi } from '../deferred/entry.js';

export { PyricDeferredApiError } from '../deferred/entry.js';

export const {
  FunctionsError, connectFunctionsEmulator, getFunctions, httpsCallable, httpsCallableFromURL,
} = deferredEntry('functions');

// Type declarations. Aliased to the deferred placeholder so a consumer's own
// annotations keep type-checking: every deferred call returns `never`, which is
// assignable to any of these. Names that Firebase exports as a CLASS appear both
// here and above — a class is a value and a type, and both meanings must survive
// the swap.
export type Functions = DeferredApi;
export type FunctionsError = DeferredApi;
export type FunctionsErrorCode = DeferredApi;
export type FunctionsErrorCodeCore = DeferredApi;
export type HttpsCallable = DeferredApi;
export type HttpsCallableOptions = DeferredApi;
export type HttpsCallableResult = DeferredApi;
export type HttpsCallableStreamOptions = DeferredApi;
export type HttpsCallableStreamResult = DeferredApi;
