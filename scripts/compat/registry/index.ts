import { authRegistry } from './auth.ts';
import { firestoreRegistry } from './firestore.ts';
import { rtdbRegistry } from './rtdb.ts';
import { storageRegistry } from './storage.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

export const surfaceRegistries = [
  authRegistry,
  firestoreRegistry,
  rtdbRegistry,
  storageRegistry,
] satisfies CompatibilitySurfaceRegistry[];

export const observationExceptions: Record<string, string> = {
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
  observationExceptions,
  rows: allCompatibilityRows,
};

export type { Automation, CompatibilityRow, CompatibilitySurfaceRegistry, OracleConformanceCheck, Surface } from './types.ts';
