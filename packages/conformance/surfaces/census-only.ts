/**
 * Export-census surfaces with no COMPAT matrix.
 *
 * The surface-census export gate covers a few `firebase/*` entry points that
 * have no compatibility matrix and so no surface descriptor: `firebase/app`
 * (no COMPAT doc) and `firebase/messaging/sw` (the service-worker receive
 * plane, whose export set differs from the client `firebase/messaging` plane).
 * They are tracked here, separate from `surfaces/*.ts`, because they carry none
 * of a descriptor's other metadata — no registry, no rows, no coverage
 * membership. surface-census.ts folds these in after the descriptor-derived
 * pairs so the census still gates them; nothing else reads this list.
 */
import type { CensusOnlyPair } from './types.ts';

export const censusOnlySurfaces: CensusOnlyPair[] = [
  { order: 0, censusSurface: 'app', upstream: 'firebase/app', mirrors: ['pyric/app'] },
  // The client plane (`firebase/messaging`) and the service-worker plane
  // (`firebase/messaging/sw`) export different symbol sets, so each is its own
  // census pair. The client plane is the `messaging` surface descriptor; the
  // service-worker plane is census-only.
  { order: 99, censusSurface: 'messaging-sw', upstream: 'firebase/messaging/sw', mirrors: ['pyric/messaging/sw'] },
];
