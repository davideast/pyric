/**
 * Surface descriptor loader.
 *
 * `surfaces/` is the index: one authored `SurfaceDescriptorRecord` per file,
 * named `<surface-key>.ts`. This loader reads the directory, requires every
 * descriptor file, derives each surface key from its filename, resolves the
 * record's `registry` key string to the registry object, and returns the typed
 * array sorted by `order`. Adding a surface is adding a file.
 *
 * Loading is synchronous (Bun's `require` handles `.ts`): consumers use the
 * descriptor list at module-evaluation time (coverage's SERVICES, the doc
 * generator's climb header), which a synchronous loader keeps simple. It throws
 * with every problem found rather than silently dropping a malformed file, on
 * the same fail-loud contract as `rigs/load.ts`.
 */
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registriesByKey } from '../registry/index.ts';
import type { Surface } from '../registry/types.ts';
import { censusOnlySurfaces } from './census-only.ts';
import type { CensusMirrorPair, SurfaceDescriptor, SurfaceDescriptorRecord } from './types.ts';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const NON_RECORD_FILES = new Set(['load.ts', 'types.ts', 'census-only.ts']);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** Structural validation for one authored record. Returns problems found (empty = valid). */
function recordProblems(file: string, value: unknown): string[] {
  const problems: string[] = [];
  const fail = (message: string) => problems.push(`surfaces/${file}: ${message}`);

  if (typeof value !== 'object' || value === null) {
    fail("does not export a 'surface' record object");
    return problems;
  }
  const record = value as Record<string, unknown>;

  if (typeof record.order !== 'number') fail("missing numeric 'order'");
  if (typeof record.registry !== 'string' || !record.registry.trim()) fail("missing 'registry' key string");
  else if (!registriesByKey[record.registry]) fail(`'registry' key '${record.registry}' resolves to no registry`);
  if (!isStringArray(record.observationPrefixes) || record.observationPrefixes.length === 0) {
    fail("'observationPrefixes' must be a non-empty string array");
  }
  if (typeof record.coverage !== 'boolean') fail("missing boolean 'coverage'");
  if (typeof record.scopeNote !== 'string' || !record.scopeNote.trim()) fail("missing 'scopeNote'");
  if (typeof record.maturity !== 'string' || !record.maturity.trim()) fail("missing 'maturity'");
  if (!isStringArray(record.captureRigs)) fail("'captureRigs' must be a string array");
  if (record.conformanceSuite !== undefined && typeof record.conformanceSuite !== 'string') {
    fail("'conformanceSuite' must be a string");
  }
  if (record.climb !== undefined && typeof record.climb !== 'boolean') fail("'climb' must be a boolean");

  // ── Descriptor-kind integrity ─────────────────────────────────────────────
  // The `kind` discriminant decides which axis fields a descriptor carries. A
  // mirror descriptor asserts an upstream exists (census fields); a native
  // descriptor asserts it does not (a declared symbolSource instead, and NONE
  // of the census fields). Nothing string-matches the surface name to decide.
  if (record.kind !== 'mirror' && record.kind !== 'native') {
    fail("missing 'kind' — must be 'mirror' or 'native'");
  } else if (record.kind === 'mirror') {
    if (typeof record.censusSurface !== 'string' || !record.censusSurface.trim()) fail("mirror descriptor missing 'censusSurface'");
    if (typeof record.upstream !== 'string' || !record.upstream.trim()) fail("mirror descriptor missing 'upstream'");
    if (!isStringArray(record.mirrors) || record.mirrors.length === 0) fail("mirror descriptor 'mirrors' must be a non-empty string array");
    if (record.symbolSource !== undefined) fail("mirror descriptor must not declare 'symbolSource'");
  } else {
    if (typeof record.symbolSource !== 'string' || !record.symbolSource.trim()) fail("native descriptor missing 'symbolSource'");
    if (record.censusSurface !== undefined) fail("native descriptor must not declare 'censusSurface' (no upstream to census)");
    if (record.upstream !== undefined) fail("native descriptor must not declare 'upstream' (no upstream to census)");
    if (record.mirrors !== undefined) fail("native descriptor must not declare 'mirrors' (no upstream to census)");
  }

  return problems;
}

/**
 * Loads every surface descriptor in this directory, resolving each record's
 * registry key to the registry object and deriving the surface key from the
 * filename. Throws with every problem found.
 */
export function loadSurfaceDescriptors(): SurfaceDescriptor[] {
  const files = readdirSync(HERE)
    .filter((file) => file.endsWith('.ts') && !NON_RECORD_FILES.has(file))
    .sort();

  const problems: string[] = [];
  const descriptors: SurfaceDescriptor[] = [];

  for (const file of files) {
    const surface = file.slice(0, -'.ts'.length) as Surface;
    const mod = require(join(HERE, file)) as { surface?: SurfaceDescriptorRecord; default?: SurfaceDescriptorRecord };
    const record = mod.surface ?? mod.default;
    const recordFailures = recordProblems(file, record);
    if (recordFailures.length > 0) {
      problems.push(...recordFailures);
      continue;
    }
    const rec = record as SurfaceDescriptorRecord;
    const registry = registriesByKey[rec.registry]!;
    const { registry: _registryKey, ...rest } = rec;
    descriptors.push({
      ...rest,
      surface,
      registryKey: rec.registry,
      registry,
      compatPath: registry.compatPath,
    });
  }

  if (problems.length > 0) {
    throw new Error(`Surface descriptor loading failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }

  return descriptors.sort((a, b) => a.order - b.order);
}

/** The loaded descriptors, evaluated once. Consumers iterate this in place of a hand-maintained list. */
export const surfaceDescriptors: SurfaceDescriptor[] = loadSurfaceDescriptors();

/**
 * The export-census mirror pairs surface-census.ts diffs. Derived from the
 * descriptors (deduped by census surface — `rtdb` and `rtdb-modular` share the
 * `database` census, counted once) and merged with the census-only surfaces
 * (`app`, `messaging-sw`). Ordered by the union of descriptor `order` and
 * census-only `order` so the census output is stable.
 */
export function loadCensusPairs(): CensusMirrorPair[] {
  const seen = new Set<string>();
  const ordered: { order: number; pair: CensusMirrorPair }[] = [];

  for (const c of censusOnlySurfaces) {
    if (seen.has(c.censusSurface)) continue;
    seen.add(c.censusSurface);
    ordered.push({ order: c.order, pair: { surface: c.censusSurface, upstream: c.upstream, mirrors: c.mirrors } });
  }
  for (const d of surfaceDescriptors) {
    // Native surfaces have no upstream to census — they contribute no pair.
    if (d.kind !== 'mirror') continue;
    if (seen.has(d.censusSurface)) continue;
    seen.add(d.censusSurface);
    ordered.push({ order: d.order, pair: { surface: d.censusSurface, upstream: d.upstream, mirrors: d.mirrors } });
  }

  return ordered.sort((a, b) => a.order - b.order).map((o) => o.pair);
}
