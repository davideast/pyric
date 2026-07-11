import { aiRegistry } from './ai.ts';
import { authRegistry } from './auth.ts';
import { firestoreRegistry } from './firestore.ts';
import { messagingRegistry } from './messaging.ts';
import { rtdbRegistry } from './rtdb.ts';
import { storageRegistry } from './storage.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

/**
 * Every generated COMPAT.md doc's registry, keyed by its `surface` field. This
 * is the key a surface descriptor's `registry` string resolves against (see
 * `surfaces/load.ts`): `rtdb` and `rtdb-modular` both resolve to the `rtdb`
 * registry, `messaging` and `messaging-admin` both to `messaging`. The array
 * order below is the doc order every consumer inherits — keep it stable.
 */
export const registriesByKey: Record<string, CompatibilitySurfaceRegistry> = Object.fromEntries(
  [aiRegistry, authRegistry, firestoreRegistry, rtdbRegistry, storageRegistry, messagingRegistry].map((r) => [r.surface, r]),
);

/** One registry per generated COMPAT.md doc (shared registries deduped, in doc order). */
export const surfaceRegistries: CompatibilitySurfaceRegistry[] = [...new Set(Object.values(registriesByKey))];

export function rowsForSurface(registry: CompatibilitySurfaceRegistry): CompatibilityRow[] {
  return registry.blocks.flatMap((block) => (block.kind === 'table' ? block.rows : []));
}

export const allCompatibilityRows = surfaceRegistries.flatMap(rowsForSurface);

export type { Automation, CompatibilityRow, CompatibilitySurfaceRegistry, CompatStatus, OracleConformanceCheck, Surface } from './types.ts';
