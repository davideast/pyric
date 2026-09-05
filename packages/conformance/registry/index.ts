import { aiRegistry } from './ai.ts';
import { appRegistry } from './app.ts';
import { authRegistry } from './auth.ts';
import { authFlutterRegistry } from './auth-flutter.ts';
import { authKotlinRegistry } from './auth-kotlin.ts';
import { authSwiftRegistry } from './auth-swift.ts';
import { firestoreRegistry } from './firestore.ts';
import { firestoreFlutterRegistry } from './firestore-flutter.ts';
import { firestoreKotlinRegistry } from './firestore-kotlin.ts';
import { firestoreSwiftRegistry } from './firestore-swift.ts';
import { functionsRtdbRegistry } from './functions-rtdb.ts';
import { messagingRegistry } from './messaging.ts';
import { rtdbRegistry } from './rtdb.ts';
import { rulesRegistry } from './rules.ts';
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
  [
    appRegistry,
    aiRegistry,
    authRegistry,
    firestoreRegistry,
    rtdbRegistry,
    storageRegistry,
    messagingRegistry,
    functionsRtdbRegistry,
    rulesRegistry,
    firestoreFlutterRegistry,
    firestoreKotlinRegistry,
    firestoreSwiftRegistry,
    authFlutterRegistry,
    authKotlinRegistry,
    authSwiftRegistry,
  ].map((r) => [r.surface, r]),
);

/** One registry per generated COMPAT.md doc (shared registries deduped, in doc order). */
export const surfaceRegistries: CompatibilitySurfaceRegistry[] = [...new Set(Object.values(registriesByKey))];

export function rowsForSurface(registry: CompatibilitySurfaceRegistry): CompatibilityRow[] {
  return registry.blocks.flatMap((block) => (block.kind === 'table' ? block.rows : []));
}

export const allCompatibilityRows = surfaceRegistries.flatMap(rowsForSurface);

export { authFlutterRegistry, authKotlinRegistry, authSwiftRegistry, firestoreKotlinRegistry };

export type { Automation, CompatibilityRow, CompatibilitySurfaceRegistry, CompatStatus, ConformanceDisposition, DeveloperSurface, OracleConformanceCheck, Surface } from './types.ts';

