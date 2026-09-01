/**
 * `pyric/performance` — a DEFERRED mirror of `firebase/performance`.
 *
 * Performance Monitoring instruments real network and render timings and
 * ships them to Google. Nothing about it is locally observable, so it is
 * deferred.
 *
 * Every symbol below resolves and links so an app that swaps `firebase` for
 * `pyric` still loads; touching one throws `PyricDeferredApiError` naming this
 * subpath. See `../deferred/entry.ts` for the full rationale.
 *
 * The value list is the exact public runtime surface of `firebase/performance`
 * (Firebase Web SDK 12.13.0). Keep it in sync when this entry graduates to a
 * real mirror.
 */
import { deferredEntry, type DeferredApi } from '../deferred/entry.js';

export { PyricDeferredApiError } from '../deferred/entry.js';

export const {
  getPerformance, initializePerformance, trace,
} = deferredEntry('performance');

// Type declarations. Aliased to the deferred placeholder so a consumer's own
// annotations keep type-checking: every deferred call returns `never`, which is
// assignable to any of these. Names that Firebase exports as a CLASS appear both
// here and above — a class is a value and a type, and both meanings must survive
// the swap.
export type FirebasePerformance = DeferredApi;
export type PerformanceSettings = DeferredApi;
export type PerformanceTrace = DeferredApi;
