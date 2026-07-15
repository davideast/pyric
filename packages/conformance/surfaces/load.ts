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
import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';
import { registriesByKey } from '../registry/index.ts';
import type { DeveloperSurface, Surface } from '../registry/types.ts';
import surfaceContractJsonSchema from '../schemas/surface-contract.v2.schema.json' with { type: 'json' };
import {
  type CensusMirrorPair,
  type CensusOnlySurfaceContract,
  type CensusSurface,
  type DispositionAvailability,
  type SurfaceContract,
  type SurfaceDescriptor,
  type SurfaceDescriptorRecord,
  type SurfaceDisposition,
} from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const validateSurfaceContract = new Ajv2020({ allErrors: true }).compile(surfaceContractJsonSchema);
const registryRowIds = new Set(Object.values(registriesByKey).flatMap((registry) =>
  registry.blocks.flatMap((block) => block.kind === 'table' ? block.rows.map((row) => row.id) : []),
));

function schemaPath(error: ErrorObject): string {
  const parts = error.instancePath.split('/').filter(Boolean).map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (error.keyword === 'required') parts.push(String(error.params.missingProperty));
  return parts.join('.');
}

function schemaProblems(file: string, value: unknown): string[] {
  if (validateSurfaceContract(value)) return [];
  return (validateSurfaceContract.errors ?? []).map((error) => {
    const path = schemaPath(error);
    if (error.keyword === 'required') return `surfaces/${file}: Required at '${path}'`;
    if (error.keyword === 'additionalProperties' || error.keyword === 'unevaluatedProperties') {
      const property = String(error.params.additionalProperty ?? error.params.unevaluatedProperty);
      return `surfaces/${file}: Unrecognized key '${property}'${path ? ` at '${path}'` : ''}`;
    }
    return `surfaces/${file}: ${error.message ?? error.keyword}${path ? ` at '${path}'` : ''}`;
  });
}

/** Cross-contract uniqueness for the exact owner set consumed by the model. */
export function censusOwnerProblems(
  records: readonly { file: string; record: SurfaceContract }[],
): string[] {
  const owners = new Map<string, string>();
  const problems: string[] = [];
  for (const { file, record } of records) {
    const ownsCensus = (record.kind === 'mirror' && record.coverage) || record.kind === 'census-only';
    if (!ownsCensus) continue;
    const prior = owners.get(record.censusSurface);
    if (prior) {
      problems.push(`surfaces/${file}: census surface '${record.censusSurface}' has multiple developer owners (also in ${prior})`);
    } else {
      owners.set(record.censusSurface, file);
    }
  }
  return problems;
}

/** Structural/schema validation for one authored contract. */
export function surfaceRecordProblems(file: string, value: unknown): string[] {
  const problems = schemaProblems(file, value);
  if (problems.length > 0) return problems;
  const record = value as SurfaceContract;
  if (record.kind !== 'census-only' && !registriesByKey[record.registry]) {
    problems.push(`surfaces/${file}: 'registry' key '${record.registry}' resolves to no registry`);
  }
  if (record.kind === 'mirror' || record.kind === 'census-only') {
    for (const group of record.dispositions) {
      for (const ref of group.evidenceRefs) {
        if (ref.startsWith('registry:') && !registryRowIds.has(ref.slice('registry:'.length))) {
          problems.push(`surfaces/${file}: registry evidence target '${ref.slice('registry:'.length)}' does not exist`);
        }
      }
    }
  }
  return problems;
}

/** Resolve developer-facing owners from the contract directory itself. */
export function surfaceReferenceProblems(
  records: readonly { key: string; file: string; record: SurfaceContract }[],
): string[] {
  const canonical = new Set(records
    .filter(({ key, record }) => record.kind !== 'census-only' && key === record.developerSurface)
    .map(({ key }) => key));
  return records.flatMap(({ file, record }) => {
    if (!canonical.has(record.developerSurface)) {
      return [`surfaces/${file}: developerSurface '${record.developerSurface}' is not a canonical developer surface`];
    }
    return [];
  });
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
    loaded.push({ key, file, record: value as SurfaceContract });
  }

  const dispositions = new Map<string, string>();
  const dispositionIds = new Map<string, string>();
  const censusPairs = new Map<string, string>();
  problems.push(...surfaceReferenceProblems(loaded));
  problems.push(...censusOwnerProblems(loaded));
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
      const priorId = dispositionIds.get(group.id);
      if (priorId) {
        problems.push(`surfaces/${file}: duplicate disposition id '${group.id}' (also in ${priorId})`);
      } else {
        dispositionIds.set(group.id, file);
      }
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

  for (const { file, record } of loaded) {
    if (record.kind !== 'mirror' && record.kind !== 'census-only') continue;
    for (const group of record.dispositions) {
      for (const ref of group.evidenceRefs) {
        if (ref.startsWith('disposition:') && !dispositionIds.has(ref.slice('disposition:'.length))) {
          problems.push(`surfaces/${file}: disposition evidence target '${ref.slice('disposition:'.length)}' does not exist`);
        }
      }
    }
  }

  if (files.length === 0) problems.push('surfaces/: no JSON surface contracts found');
  if (problems.length > 0) {
    throw new Error(`Surface contract loading failed:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
  }
  return loaded.sort((a, b) => a.key.localeCompare(b.key));
}

const loadedContracts = loadContracts();
export const surfaceContracts: ReadonlyArray<{ key: string; record: SurfaceContract }> =
  loadedContracts.map(({ key, record }) => ({ key, record }));
export const developerSurfaces: readonly DeveloperSurface[] = [...new Set(loadedContracts
  .filter(({ key, record }) => record.kind !== 'census-only' && key === record.developerSurface)
  .map(({ key }) => key))].sort();

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
    result.push({
      surface: record.censusSurface,
      upstream: record.upstream,
      mirrors: [...record.mirrors],
      privateRuntimeExports: [...record.privateRuntimeExports],
    });
  }
  return result;
}

export function loadSurfaceDispositions(): SurfaceDisposition[] {
  return loadedContracts.flatMap(({ record }) => {
    if (record.kind !== 'mirror' && record.kind !== 'census-only') return [];
    return record.dispositions.flatMap((group) =>
      group.symbols.map((symbol): SurfaceDisposition => {
        const base = {
          surface: record.censusSurface,
          symbol,
          dispositionId: group.id,
          summary: group.summary,
          evidenceRefs: [...group.evidenceRefs],
        };
        return group.availability === 'deferred'
          ? { ...base, availability: group.availability, reasonCode: group.reasonCode }
          : { ...base, availability: group.availability, reasonCode: group.reasonCode };
      }),
    );
  });
}

export function dispositionsFor(surface: CensusSurface): Map<string, string> {
  return new Map(loadSurfaceDispositions()
    .filter((entry) => entry.surface === surface)
    .map((entry) => [entry.symbol, entry.summary]));
}

export function dispositionTiersFor(surface: CensusSurface): Map<string, DispositionAvailability> {
  return new Map(loadSurfaceDispositions()
    .filter((entry) => entry.surface === surface)
    .map((entry) => [entry.symbol, entry.availability]));
}

export type { CensusOnlySurfaceContract, SurfaceDescriptorRecord };
