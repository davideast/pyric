/**
 * Schema-validated loader for the authored machine-readable surface contracts.
 *
 * The JSON files are the only authored source for surface identity, census
 * pairs, scope, observation ownership, and public-runtime dispositions.
 * Callers consume resolved descriptors, census pairs, or dispositions through
 * this module and never parse policy data independently.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registriesByKey } from '../registry/index.ts';
import type { Surface } from '../registry/types.ts';
import {
  surfaceContractSchema,
  type CensusMirrorPair,
  type CensusOnlySurfaceContract,
  type CensusSurface,
  type DispositionTier,
  type SurfaceContract,
  type SurfaceDescriptor,
  type SurfaceDescriptorRecord,
  type SurfaceDisposition,
} from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

function zodProblems(file: string, value: unknown): string[] {
  const result = surfaceContractSchema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? ` at '${issue.path.join('.')}'` : '';
    return `surfaces/${file}: ${issue.message}${path}`;
  });
}

/** Structural/schema validation for one authored contract. */
export function surfaceRecordProblems(file: string, value: unknown): string[] {
  const problems = zodProblems(file, value);
  if (problems.length > 0) return problems;
  const record = value as SurfaceContract;
  if (record.kind !== 'census-only' && !registriesByKey[record.registry]) {
    problems.push(`surfaces/${file}: 'registry' key '${record.registry}' resolves to no registry`);
  }
  return problems;
}

function loadContracts(): { key: string; file: string; record: SurfaceContract }[] {
  const files = readdirSync(HERE).filter((file) => file.endsWith('.json')).sort();
  const loaded: { key: string; file: string; record: SurfaceContract }[] = [];
  const problems: string[] = [];

  for (const file of files) {
    const key = file.slice(0, -'.json'.length);
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(join(HERE, file), 'utf8'));
    } catch (error) {
      problems.push(`surfaces/${file}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const recordProblems = surfaceRecordProblems(file, value);
    if (recordProblems.length > 0) {
      problems.push(...recordProblems);
      continue;
    }
    loaded.push({ key, file, record: surfaceContractSchema.parse(value) });
  }

  const dispositions = new Map<string, string>();
  const censusPairs = new Map<string, string>();
  for (const { file, record } of loaded) {
    if (record.kind !== 'mirror' && record.kind !== 'census-only') continue;
    const pairValue = JSON.stringify([record.upstream, record.mirrors]);
    const priorPair = censusPairs.get(record.censusSurface);
    if (priorPair && priorPair !== pairValue) {
      problems.push(`surfaces/${file}: census surface '${record.censusSurface}' conflicts with another upstream/mirror pair`);
    } else {
      censusPairs.set(record.censusSurface, pairValue);
    }
    for (const group of record.dispositions) {
      for (const symbol of group.symbols) {
        const key = `${record.censusSurface}\0${symbol}`;
        const prior = dispositions.get(key);
        if (prior) {
          problems.push(`surfaces/${file}: duplicate disposition for ${record.censusSurface} runtime symbol '${symbol}' (also in ${prior})`);
        } else {
          dispositions.set(key, file);
        }
      }
    }
  }

  if (files.length === 0) problems.push('surfaces/: no JSON surface contracts found');
  if (problems.length > 0) {
    throw new Error(`Surface contract loading failed:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
  }
  return loaded.sort((a, b) => a.record.order - b.record.order || a.key.localeCompare(b.key));
}

const loadedContracts = loadContracts();
export const surfaceContracts: ReadonlyArray<{ key: string; record: SurfaceContract }> =
  loadedContracts.map(({ key, record }) => ({ key, record }));

export function loadSurfaceDescriptors(): SurfaceDescriptor[] {
  return loadedContracts.flatMap(({ key, record }) => {
    if (record.kind === 'census-only') return [];
    const registry = registriesByKey[record.registry]!;
    const { registry: registryKey, ...rest } = record;
    return [{
      ...rest,
      surface: key as Surface,
      registryKey,
      registry,
      compatPath: registry.compatPath,
    } as SurfaceDescriptor];
  });
}

export const surfaceDescriptors: SurfaceDescriptor[] = loadSurfaceDescriptors();

export function loadCensusPairs(): CensusMirrorPair[] {
  const seen = new Set<CensusSurface>();
  const result: CensusMirrorPair[] = [];
  for (const { record } of loadedContracts) {
    if (record.kind !== 'mirror' && record.kind !== 'census-only') continue;
    if (seen.has(record.censusSurface)) continue;
    seen.add(record.censusSurface);
    result.push({ surface: record.censusSurface, upstream: record.upstream, mirrors: [...record.mirrors] });
  }
  return result;
}

export function loadSurfaceDispositions(): SurfaceDisposition[] {
  return loadedContracts.flatMap(({ record }) => {
    if (record.kind !== 'mirror' && record.kind !== 'census-only') return [];
    return record.dispositions.flatMap((group) =>
      group.symbols.map((symbol) => ({
        surface: record.censusSurface,
        symbol,
        reason: group.reason,
        tier: group.tier,
      })),
    );
  });
}

export function dispositionsFor(surface: CensusSurface): Map<string, string> {
  return new Map(loadSurfaceDispositions()
    .filter((entry) => entry.surface === surface)
    .map((entry) => [entry.symbol, entry.reason]));
}

export function dispositionTiersFor(surface: CensusSurface): Map<string, DispositionTier> {
  return new Map(loadSurfaceDispositions()
    .filter((entry) => entry.surface === surface)
    .map((entry) => [entry.symbol, entry.tier]));
}

export type { CensusOnlySurfaceContract, SurfaceDescriptorRecord };
