/**
 * Export-census surfaces with no COMPAT matrix.
 *
 * The surface-census export gate covers a `firebase/*` entry point that has no
 * compatibility matrix and so no surface descriptor: `firebase/messaging/sw`
 * (the service-worker receive plane, whose export set differs from the client
 * `firebase/messaging` plane). It is tracked here, separate from `surfaces/*.ts`,
 * because it carries none of a descriptor's other metadata — no registry, no
 * rows, no coverage membership. surface-census.ts folds it in after the
 * descriptor-derived pairs so the census still gates it; nothing else reads this
 * list. (`firebase/app` was formerly here too; it is now a full mirror surface —
 * see surfaces/app.ts.)
 */
import type { CensusOnlyPair } from './types.ts';

export const censusOnlySurfaces: CensusOnlyPair[] = [
  // The client plane (`firebase/messaging`) and the service-worker plane
  // (`firebase/messaging/sw`) export different symbol sets, so each is its own
  // census pair. The client plane is the `messaging` surface descriptor; the
  // service-worker plane is census-only.
  { order: 99, censusSurface: 'messaging-sw', upstream: 'firebase/messaging/sw', mirrors: ['pyric/messaging/sw'] },
];
