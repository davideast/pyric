/**
 * `@pyric/ui/events` — headless activity view over the unified
 * `SandboxEvent` stream (Pyric Studio's keystone). Aggregates the whole
 * stream (Firestore request/write + the cross-service `service_mutation`
 * envelope for auth/storage/rtdb) into category bands with per-row
 * provenance — the activity grid. Sibling to `@pyric/ui/traffic` (which
 * is per-request, not aggregated-by-category).
 *
 * Ships zero styling — Pyric Studio applies the `data-pyric-*` contract.
 */
export * from './hooks/index.js';
export * from './components/index.js';

export {
  computeActivityDigest,
  type ActivityDigest,
  type ActivityDigestOptions,
  type ActivityGroupBy,
  type ActivityBand,
  type ActivityBandWithGroups,
  type ActivitySubgroup,
  type ActivityBandKey,
  type ActivityRow,
} from './digest.js';

export type {
  ActivityEvent,
  AnyActivityEvent,
  ActivitySource,
  ActivityRequestEvent,
  ActivityWriteEvent,
  ActivityServiceMutationEvent,
  ActivityProvenance,
  ActivityService,
  ActivityActor,
  ActivityLens,
  ActivityResult,
  ActivityAuthState,
} from './types.js';
