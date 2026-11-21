import { aiRegistry } from './ai.ts';
import { appRegistry } from './app.ts';
import { appCheckRegistry } from './app-check.ts';
import { appCheckFlutterRegistry } from './app-check-flutter.ts';
import { appCheckKotlinRegistry } from './app-check-kotlin.ts';
import { appCheckSwiftRegistry } from './app-check-swift.ts';
import { authRegistry } from './auth.ts';
import { authFlutterRegistry } from './auth-flutter.ts';
import { authKotlinRegistry } from './auth-kotlin.ts';
import { authSwiftRegistry } from './auth-swift.ts';
import { firestoreRegistry } from './firestore.ts';
import { firestoreFlutterRegistry } from './firestore-flutter.ts';
import { firestoreKotlinRegistry } from './firestore-kotlin.ts';
import { firestoreSwiftRegistry } from './firestore-swift.ts';
import { functionsCallableRegistry } from './functions-callable.ts';
import { functionsFlutterRegistry } from './functions-flutter.ts';
import { functionsHttpRegistry } from './functions-http.ts';
import { functionsKotlinRegistry } from './functions-kotlin.ts';
import { functionsRtdbRegistry } from './functions-rtdb.ts';
import { functionsSwiftRegistry } from './functions-swift.ts';
import { messagingRegistry } from './messaging.ts';
import { rtdbRegistry } from './rtdb.ts';
import { rtdbFlutterRegistry } from './rtdb-flutter.ts';
import { rtdbKotlinRegistry } from './rtdb-kotlin.ts';
import { rtdbSwiftRegistry } from './rtdb-swift.ts';
import { rulesRegistry } from './rules.ts';
import { storageRegistry } from './storage.ts';
import { storageFlutterRegistry } from './storage-flutter.ts';
import { storageKotlinRegistry } from './storage-kotlin.ts';
import { storageSwiftRegistry } from './storage-swift.ts';
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
    appCheckRegistry,
    functionsRtdbRegistry,
    functionsHttpRegistry,
    functionsCallableRegistry,
    rulesRegistry,
    firestoreFlutterRegistry,
    firestoreKotlinRegistry,
    firestoreSwiftRegistry,
    authFlutterRegistry,
    authKotlinRegistry,
    authSwiftRegistry,
    rtdbFlutterRegistry,
    rtdbKotlinRegistry,
    rtdbSwiftRegistry,
    storageFlutterRegistry,
    storageKotlinRegistry,
    storageSwiftRegistry,
    appCheckFlutterRegistry,
    appCheckKotlinRegistry,
    appCheckSwiftRegistry,
    functionsFlutterRegistry,
    functionsKotlinRegistry,
    functionsSwiftRegistry,
  ].map((r) => [r.surface, r]),
);

/** One registry per generated COMPAT.md doc (shared registries deduped, in doc order). */
export const surfaceRegistries: CompatibilitySurfaceRegistry[] = [...new Set(Object.values(registriesByKey))];

export function rowsForSurface(registry: CompatibilitySurfaceRegistry): CompatibilityRow[] {
  return registry.blocks.flatMap((block) => (block.kind === 'table' ? block.rows : []));
}

export const allCompatibilityRows = surfaceRegistries.flatMap(rowsForSurface);

export {
  appCheckFlutterRegistry,
  appCheckKotlinRegistry,
  appCheckSwiftRegistry,
  authFlutterRegistry,
  authKotlinRegistry,
  authSwiftRegistry,
  firestoreKotlinRegistry,
  functionsFlutterRegistry,
  functionsKotlinRegistry,
  functionsSwiftRegistry,
  rtdbFlutterRegistry,
  rtdbKotlinRegistry,
  rtdbSwiftRegistry,
  storageFlutterRegistry,
  storageKotlinRegistry,
  storageSwiftRegistry,
};

export type { Automation, CompatibilityRow, CompatibilitySurfaceRegistry, CompatStatus, ConformanceDisposition, DeveloperSurface, OracleConformanceCheck, Surface } from './types.ts';

