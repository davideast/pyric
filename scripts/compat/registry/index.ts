import { authRegistry } from './auth.ts';
import { firestoreRegistry } from './firestore.ts';
import { messagingRegistry } from './messaging.ts';
import { rtdbRegistry } from './rtdb.ts';
import { storageRegistry } from './storage.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry, SurfaceDescriptor } from './types.ts';

/**
 * The one list of compatibility surfaces. Every script derives its surface
 * knowledge from here — adding a surface is a registry file plus one entry.
 * `rtdb` and `rtdb-modular` share the rtdb registry (and its COMPAT.md doc)
 * but keep distinct observation filename prefixes.
 */
export const surfaceDescriptors: SurfaceDescriptor[] = [
  { surface: 'auth', registry: authRegistry, observationPrefix: 'auth-' },
  { surface: 'firestore', registry: firestoreRegistry, observationPrefix: 'firestore-' },
  { surface: 'rtdb', registry: rtdbRegistry, observationPrefix: 'rtdb-' },
  { surface: 'rtdb-modular', registry: rtdbRegistry, observationPrefix: 'rtdb-modular-' },
  { surface: 'storage', registry: storageRegistry, observationPrefix: 'storage-' },
  // Messaging is the first surface admitted under Conformance Driven Development
  // (docs/conformance/cdd.md). Two surfaces share ONE registry file and ONE
  // COMPAT doc, on the rtdb / rtdb-modular precedent (resolved decision #4):
  //   - `messaging`       — client + service-worker receive planes (pyric),
  //     receive-plane captures under the `messaging-web-` filename prefix.
  //   - `messaging-admin` — admin send plane (pyric-admin), send-plane captures
  //     under the `messaging-send-` filename prefix.
  // The prefixes partition the 17 committed observations exactly (7 web, 10
  // send); longest-prefix wins over the retired `messaging-` catch-all. Both
  // are `climb: true`, so the report's climb section and the doc's climb header
  // pick them up automatically.
  {
    surface: 'messaging',
    registry: messagingRegistry,
    observationPrefix: 'messaging-web-',
    conformanceSuite: 'packages/pyric/test/messaging/oracle-conformance.test.ts',
    climb: true,
  },
  {
    surface: 'messaging-admin',
    registry: messagingRegistry,
    observationPrefix: 'messaging-send-',
    conformanceSuite: 'packages/pyric-admin/test/messaging/oracle-conformance.test.ts',
    climb: true,
  },
  // `admin-app-` observations are Phase-A bootstrap captures of firebase-admin's
  // in-process app registry (initializeApp / getApp / accessors). They have no
  // matrix rows yet (those land post-publish) and are individually listed in
  // `observationExceptions` below, so this descriptor only teaches the validator
  // that `admin-app-` is a recognized observation filename prefix. It reuses the
  // existing `auth` registry — it adds NO new COMPAT.md doc and NO matrix rows.
  { surface: 'auth', registry: authRegistry, observationPrefix: 'admin-app-' },
];

/** One registry per generated COMPAT.md doc (shared registries deduped). */
export const surfaceRegistries: CompatibilitySurfaceRegistry[] = [...new Set(surfaceDescriptors.map((d) => d.registry))];

export const observationExceptions: Record<string, string> = {
  // The 17 `messaging-*` observations are no longer parked here: the messaging
  // surface has been admitted under CDD and every capture is now cited by an
  // authored (born-unverified) row in scripts/compat/registry/messaging.ts.
  // compat:validate now enforces normal linkage on the `messaging-` prefix.
  "admin-app-initializeapp-noarg-default": "admin bootstrap capture; admin matrix rows land post-publish",
  "admin-app-initializeapp-named": "admin bootstrap capture; admin matrix rows land post-publish",
  "admin-app-initializeapp-reinit-idempotent": "admin bootstrap capture; admin matrix rows land post-publish",
  "admin-app-initializeapp-duplicate-different-config": "admin bootstrap capture; admin matrix rows land post-publish",
  "admin-app-initializeapp-autoinit-mismatch": "admin bootstrap capture; admin matrix rows land post-publish",
  "admin-app-initializeapp-invalid-name": "admin bootstrap capture; admin matrix rows land post-publish",
  "admin-app-getapp-unknown-name": "admin bootstrap capture; admin matrix rows land post-publish",
  "admin-app-no-app-error": "admin bootstrap capture; admin matrix rows land post-publish",
  "admin-app-accessors-resolve-default": "admin bootstrap capture; admin matrix rows land post-publish",
  "admin-app-getdatabase-missing-url": "admin bootstrap capture; admin matrix rows land post-publish",
  "admin-app-deleteapp": "admin bootstrap capture; admin matrix rows land post-publish",
  "rtdb-onvalue-fires-on-set": "Upstream listener-shape observation for the agent-tool deny-list; it intentionally references the deny-listed listener family rather than a single implemented matrix row.",
  "rtdb-servertimestamp-resolves": "Upstream sentinel-shape observation for the agent-tool deny-list; it intentionally references the deny-listed sentinel family rather than a single implemented matrix row.",
  "rtdb-modular-orderbyvalue-numeric": "Prod rejected the query because the oracle project lacked the required .indexOn; the observation documents index enforcement rather than a directly matching matrix row.",
  "rtdb-modular-onchildmoved-with-orderby": "Locks ordered-query child_moved upstream shape while the current matrix row documents the plain-ref no-fire sandbox behavior."
};

export function rowsForSurface(registry: CompatibilitySurfaceRegistry): CompatibilityRow[] {
  return registry.blocks.flatMap((block) => block.kind === 'table' ? block.rows : []);
}

export const allCompatibilityRows = surfaceRegistries.flatMap(rowsForSurface);

export const compatibilityRegistry = {
  version: 2,
  surfaces: surfaceRegistries,
  surfaceDescriptors,
  observationExceptions,
  rows: allCompatibilityRows,
};

export type { Automation, CompatibilityRow, CompatibilitySurfaceRegistry, CompatStatus, OracleConformanceCheck, Surface, SurfaceDescriptor } from './types.ts';
