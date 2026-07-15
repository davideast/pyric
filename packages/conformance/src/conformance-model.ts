#!/usr/bin/env bun
/**
 * The derived, multi-axis conformance read model.
 *
 * Canonical registries, rules-language inventories, and surface contracts are
 * joined here once. Consumer bundles are disposable projections of this model;
 * they never become inputs to another derivation.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { surfaceRegistries, type CompatibilityRow, type CompatStatus, type Surface } from '../registry/index.ts';
import { loadAllSnapshots } from '../rules-language/load.ts';
import { buildSurfaceCensus, type SurfaceCensus } from './surface-census.ts';
import {
  RUNTIME_TS_PATH,
  deriveAllNodeVerdicts,
  deriveConformanceEvidence,
  renderConformanceVerdicts,
  type ConformanceVerdict,
} from './conformance-verdicts.ts';
import { surfaceDescriptors } from '../surfaces/load.ts';
import type { CapabilityReport } from './rules-language-capability.ts';
import type { CoverageReport } from './rules-language-analyzer.ts';
import type { SurfaceDescriptor } from '../surfaces/types.ts';
import type { CompatibilitySurfaceRegistry } from '../registry/types.ts';
import coverageBaselineJson from '../baselines/coverage-baseline.json' with { type: 'json' };
import { loadObservations, type Observation } from '../observations/load.ts';
import { observationExceptions } from '../exceptions/load.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CLI_QUERY_PATH = join(HERE, '..', '..', 'cli', 'src', 'conformance', '.generated', 'can-i-use.ts');

export type DeveloperSurface =
  | 'app' | 'ai' | 'auth' | 'firestore' | 'rtdb' | 'storage'
  | 'messaging' | 'messaging-admin' | 'functions-rtdb'
  | 'firestore-rules' | 'storage-rules' | 'rtdb-rules';
export type Availability = 'available' | 'deferred' | 'out-of-scope';
export type Fidelity = 'conforms' | 'diverged' | 'bug' | 'unverified' | 'not-applicable';
export type Assurance = 'eligible' | 'qualified' | 'ineligible' | 'not-applicable';

export interface FeatureClaim {
  id: string;
  kind: 'runtime-export' | 'type-export' | 'registry-row' | 'rules-construct';
  surface: string;
  behavior: string;
  status: string;
  evidence: readonly string[];
  assurance: Assurance;
}

export interface FeatureSupport {
  feature: string;
  surface: DeveloperSurface;
  availability: Availability;
  fidelity: Fidelity;
  assurance: Assurance;
  summary: string;
  caveats: readonly string[];
  claims: readonly FeatureClaim[];
}

export interface ConformanceModel {
  supports: readonly FeatureSupport[];
  nodeVerdicts: Readonly<Record<string, ConformanceVerdict>>;
  census: readonly SurfaceCensus[];
  rulesLanguage: {
    capability: CapabilityReport;
    coverage: CoverageReport;
  };
  documentation: {
    registries: readonly CompatibilitySurfaceRegistry[];
    descriptors: readonly SurfaceDescriptor[];
    coverageBaseline: CoverageBaseline;
    rows: readonly CompatibilityRow[];
  };
  evidence: {
    observations: readonly Observation[];
    observationExceptions: Readonly<Record<string, string>>;
  };
}

export interface CoverageBaseline {
  services: Record<string, {
    publicSurface?: {
      runtime: { mapped: number; denominator: number; pct: number };
      types: { mapped: number; denominator: number; pct: number };
    };
    native?: boolean;
    integration?: boolean;
  }>;
  overall: {
    publicSurface: {
      runtime: { mapped: number; denominator: number; pct: number };
      types: { mapped: number; denominator: number; pct: number };
    };
  };
  rowStatuses: Record<string, string>;
}

interface MutableFeature {
  feature: string;
  surface: DeveloperSurface;
  availability: Availability;
  claims: FeatureClaim[];
  registryStatuses: CompatStatus[];
  assuranceVerdicts: ConformanceVerdict[];
  caveats: string[];
}

function developerSurface(surface: Surface | string): DeveloperSurface {
  if (surface === 'rtdb' || surface === 'rtdb-modular') return 'rtdb';
  if (surface === 'rules') return 'firestore-rules';
  return surface as DeveloperSurface;
}

export function normalizeFeature(value: string): string {
  return value.trim().replace(/\(.*\)$/, '').replace(/[\s_-]+/g, '').toLowerCase();
}

function featureNamesForRow(row: CompatibilityRow): string[] {
  if (row.featureKeys?.length) return [...row.featureKeys];
  const names = new Set<string>();
  for (const alias of row.aliases) {
    if (/^[A-Za-z_$][\w$]*$/.test(alias)) names.add(alias);
  }
  const direct = row.api.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:\(|$)/);
  if (direct) names.add(direct[1]!);
  for (const match of row.api.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) names.add(match[1]!);
  return [...names].filter((name) => !['if', 'for', 'match', 'allow'].includes(name));
}

function rows(): CompatibilityRow[] {
  return surfaceRegistries.flatMap((registry) => registry.blocks.flatMap((block) => block.kind === 'table' ? block.rows : []));
}

function fidelityOf(statuses: CompatStatus[]): Fidelity {
  if (statuses.length === 0) return 'not-applicable';
  if (statuses.includes('bug')) return 'bug';
  if (statuses.includes('diverged-documented')) return 'diverged';
  if (statuses.includes('unsupported') || statuses.includes('unverified')) return 'unverified';
  return 'conforms';
}

function assuranceOf(verdicts: ConformanceVerdict[]): Assurance {
  if (verdicts.length === 0) return 'not-applicable';
  if (verdicts.includes('unsupported')) return 'ineligible';
  if (verdicts.includes('qualified')) return 'qualified';
  return 'eligible';
}

function availabilityRank(value: Availability): number {
  return value === 'available' ? 2 : value === 'deferred' ? 1 : 0;
}

function summarize(feature: MutableFeature, fidelity: Fidelity, assurance: Assurance): string {
  if (feature.availability !== 'available') {
    return `${feature.feature} is ${feature.availability}; behavior fidelity and assurance are not applicable until the surface exists.`;
  }
  const fidelityText = fidelity === 'not-applicable' ? 'has no applicable behavior claim' : `has ${fidelity} fidelity`;
  const assuranceText = assurance === 'not-applicable' ? 'has no assurance classification' : `is ${assurance} for assurance`;
  return `${feature.feature} is available, ${fidelityText}, and ${assuranceText}.`;
}

let sharedModel: Promise<ConformanceModel> | undefined;

/** Derive the immutable read model once per process and share it across every
 * consumer. CI and docs commonly ask several adapters for the same commit's
 * facts; recomputing the live TypeScript census for each adapter adds no trust. */
export function deriveConformanceModel(): Promise<ConformanceModel> {
  return sharedModel ??= buildConformanceModel();
}

async function buildConformanceModel(): Promise<ConformanceModel> {
  const census = await buildSurfaceCensus();
  const evidence = await deriveConformanceEvidence();
  const verdicts = deriveAllNodeVerdicts(evidence.graph);
  const features = new Map<string, MutableFeature>();
  const censusOwner = new Map(surfaceDescriptors.flatMap((descriptor) =>
    descriptor.kind === 'mirror' ? [[descriptor.censusSurface, developerSurface(descriptor.surface)] as const] : [],
  ));
  censusOwner.set('messaging-sw', 'messaging');

  const ensure = (name: string, surface: DeveloperSurface, availability: Availability): MutableFeature => {
    const key = `${surface}/${normalizeFeature(name)}`;
    const existing = features.get(key);
    if (existing) {
      if (/^[a-z]/.test(name) && /^[A-Z]/.test(existing.feature)) existing.feature = name;
      if (availabilityRank(availability) > availabilityRank(existing.availability)) existing.availability = availability;
      return existing;
    }
    const created: MutableFeature = {
      feature: name, surface, availability, claims: [], registryStatuses: [], assuranceVerdicts: [], caveats: [],
    };
    features.set(key, created);
    return created;
  };

  for (const entry of census) {
    const surface = censusOwner.get(entry.surface) ?? developerSurface(entry.surface);
    for (const symbol of entry.runtime.mapped) {
      ensure(symbol, surface, 'available').claims.push({
        id: `${entry.surface}:runtime:${symbol}`, kind: 'runtime-export', surface: entry.surface,
        behavior: `${symbol} is exported by the Pyric mirror`, status: 'mapped', evidence: [], assurance: 'not-applicable',
      });
    }
    for (const disposition of entry.runtime.dispositioned) {
      const feature = ensure(disposition.symbol, surface, disposition.tier);
      feature.caveats.push(disposition.reason);
      feature.claims.push({
        id: `${entry.surface}:runtime:${disposition.symbol}`, kind: 'runtime-export', surface: entry.surface,
        behavior: disposition.reason, status: disposition.tier, evidence: [], assurance: 'not-applicable',
      });
    }
    for (const symbol of entry.runtime.unmapped) {
      const feature = ensure(symbol, surface, 'deferred');
      feature.caveats.push('Public runtime export is not mirrored and has no reviewed disposition.');
      feature.claims.push({
        id: `${entry.surface}:runtime:${symbol}`, kind: 'runtime-export', surface: entry.surface,
        behavior: `${symbol} is not exported by the Pyric mirror`, status: 'unmapped', evidence: [], assurance: 'not-applicable',
      });
    }
    for (const symbol of entry.types.mapped) {
      ensure(symbol, surface, 'available').claims.push({
        id: `${entry.surface}:type:${symbol}`, kind: 'type-export', surface: entry.surface,
        behavior: `${symbol} is exported in the Pyric type namespace`, status: 'mapped', evidence: [], assurance: 'not-applicable',
      });
    }
    for (const symbol of entry.types.unmapped) {
      const feature = ensure(symbol, surface, 'deferred');
      feature.caveats.push('Public type export is not mirrored.');
      feature.claims.push({
        id: `${entry.surface}:type:${symbol}`, kind: 'type-export', surface: entry.surface,
        behavior: `${symbol} is missing from the Pyric type namespace`, status: 'unmapped', evidence: [], assurance: 'not-applicable',
      });
    }
  }

  for (const row of rows()) {
    const rowVerdict = verdicts[row.id];
    for (const name of featureNamesForRow(row)) {
      const feature = ensure(name, developerSurface(row.surface), 'available');
      feature.registryStatuses.push(row.status);
      if (rowVerdict) feature.assuranceVerdicts.push(rowVerdict);
      if (row.status !== 'conforms') feature.caveats.push(row.behavior, row.evidence);
      feature.claims.push({
        id: row.id, kind: 'registry-row', surface: row.surface, behavior: row.behavior, status: row.status,
        evidence: [row.evidence, ...row.oracleObservations.map((id) => `observation:${id}`), ...row.conformanceTests],
        assurance: rowVerdict ? assuranceOf([rowVerdict]) : 'not-applicable',
      });
    }
  }

  for (const snapshot of Object.values(loadAllSnapshots())) {
    for (const construct of snapshot.constructs) {
      const names = construct.featureKeys?.length ? construct.featureKeys : [construct.id.split('.').at(-1)!];
      const verdict = verdicts[construct.id];
      for (const name of names) {
        const feature = ensure(name, developerSurface(`${construct.engine}-rules`), 'available');
        if (verdict) feature.assuranceVerdicts.push(verdict);
        feature.claims.push({
          id: construct.id, kind: 'rules-construct', surface: `${construct.engine}-rules`,
          behavior: construct.note ?? `${name} is enumerated in the ${construct.engine} rules-language inventory`,
          status: construct.status, evidence: [construct.reference, construct.probeNote].filter((value): value is string => Boolean(value)),
          assurance: verdict ? assuranceOf([verdict]) : 'not-applicable',
        });
      }
    }
  }

  const supports = [...features.values()].map((feature): FeatureSupport => {
    const fidelity = feature.availability === 'available' ? fidelityOf(feature.registryStatuses) : 'not-applicable';
    const assurance = feature.availability === 'available' ? assuranceOf(feature.assuranceVerdicts) : 'not-applicable';
    return {
      feature: feature.feature,
      surface: feature.surface,
      availability: feature.availability,
      fidelity,
      assurance,
      summary: summarize(feature, fidelity, assurance),
      caveats: [...new Set(feature.caveats)],
      claims: feature.claims.sort((a, b) => a.id.localeCompare(b.id)),
    };
  }).sort((a, b) => normalizeFeature(a.feature).localeCompare(normalizeFeature(b.feature)) || a.surface.localeCompare(b.surface));
  return {
    supports,
    nodeVerdicts: verdicts,
    census,
    rulesLanguage: {
      capability: evidence.capabilityReport,
      coverage: evidence.coverageReport,
    },
    documentation: {
      registries: surfaceRegistries,
      descriptors: surfaceDescriptors,
      coverageBaseline: coverageBaselineJson as CoverageBaseline,
      rows: rows(),
    },
    evidence: {
      observations: loadObservations(),
      observationExceptions,
    },
  };
}

function distance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const prior = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = prior;
    }
  }
  return row[right.length]!;
}

export function canIUse(model: ConformanceModel, query: string): FeatureSupport | FeatureSupport[] {
  const trimmed = query.trim();
  const separator = Math.max(trimmed.indexOf('/'), trimmed.indexOf(':'));
  const requestedSurface = separator > 0 ? trimmed.slice(0, separator).toLowerCase() : undefined;
  const requestedFeature = separator > 0 ? trimmed.slice(separator + 1) : trimmed;
  const normalized = normalizeFeature(requestedFeature);
  const candidates = model.supports.filter((support) =>
    (!requestedSurface || support.surface === requestedSurface) && normalizeFeature(support.feature) === normalized,
  );
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) return candidates;

  return model.supports
    .filter((support) => !requestedSurface || support.surface === requestedSurface)
    .map((support) => {
      const name = normalizeFeature(support.feature);
      const score = name.startsWith(normalized) ? 0 : name.includes(normalized) ? 1 : 2 + distance(normalized, name);
      return { support, score };
    })
    .filter(({ score }) => score <= Math.max(4, Math.ceil(normalized.length / 3) + 2))
    .sort((a, b) => a.score - b.score || a.support.feature.localeCompare(b.support.feature) || a.support.surface.localeCompare(b.support.surface))
    .slice(0, 8)
    .map(({ support }) => support);
}

export function renderCliQuery(model: ConformanceModel): string {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const pureStart = source.indexOf('function distance(');
  const pureEnd = source.indexOf('\nexport function renderCliQuery');
  const pureFunctions = source.slice(pureStart, pureEnd)
    .replace('export function canIUse(model: ConformanceModel, query: string)', 'export function canIUse(query: string)')
    .replaceAll('model.supports', 'CONFORMANCE_MODEL.supports');
  return [
    '// GENERATED FILE. Do not edit or commit.',
    '// Source: packages/conformance/src/conformance-model.ts',
    `export type DeveloperSurface = ${JSON.stringify(['app','ai','auth','firestore','rtdb','storage','messaging','messaging-admin','functions-rtdb','firestore-rules','storage-rules','rtdb-rules']).replaceAll('"', "'").replace('[', '').replace(']', '').replaceAll(',', ' |')};`,
    "export type Availability = 'available' | 'deferred' | 'out-of-scope';",
    "export type Fidelity = 'conforms' | 'diverged' | 'bug' | 'unverified' | 'not-applicable';",
    "export type Assurance = 'eligible' | 'qualified' | 'ineligible' | 'not-applicable';",
    'export interface FeatureClaim { id: string; kind: string; surface: string; behavior: string; status: string; evidence: readonly string[]; assurance: Assurance; }',
    'export interface FeatureSupport { feature: string; surface: DeveloperSurface; availability: Availability; fidelity: Fidelity; assurance: Assurance; summary: string; caveats: readonly string[]; claims: readonly FeatureClaim[]; }',
    'interface ConformanceModel { supports: readonly FeatureSupport[]; }',
    `const CONFORMANCE_MODEL: ConformanceModel = ${JSON.stringify({ supports: model.supports })};`,
    'export function normalizeFeature(value: string): string { return value.trim().replace(/\\(.*\\)$/, "").replace(/[\\s_-]+/g, "").toLowerCase(); }',
    pureFunctions,
    '',
  ].join('\n');
}

if (import.meta.main) {
  const model = await deriveConformanceModel();
  const rendered = renderCliQuery(model);
  const verdicts = renderConformanceVerdicts(model.nodeVerdicts);
  if (process.argv.includes('--write')) {
    mkdirSync(dirname(CLI_QUERY_PATH), { recursive: true });
    mkdirSync(dirname(RUNTIME_TS_PATH), { recursive: true });
    writeFileSync(CLI_QUERY_PATH, rendered);
    writeFileSync(RUNTIME_TS_PATH, verdicts);
    console.log(`Wrote ${CLI_QUERY_PATH}`);
    console.log(`Wrote ${RUNTIME_TS_PATH}`);
  } else if (process.argv.includes('--check')) {
    for (const [path, source] of [[CLI_QUERY_PATH, rendered], [RUNTIME_TS_PATH, verdicts]] as const) {
      let current = '';
      try { current = readFileSync(path, 'utf8'); } catch { /* reported below */ }
      if (current !== source) {
        console.error(`Generated conformance projection is missing or stale: ${path}`);
        process.exitCode = 1;
      }
    }
  }
  console.log(`Conformance model: ${model.supports.length} developer feature result(s), ${Buffer.byteLength(rendered)} bytes`);
  const counts = { supported: 0, qualified: 0, unsupported: 0 };
  for (const verdict of Object.values(model.nodeVerdicts)) counts[verdict]++;
  console.log(`Conformance verdicts: ${Object.keys(model.nodeVerdicts).length} nodes (${counts.supported} supported, ${counts.qualified} qualified, ${counts.unsupported} unsupported)`);
  console.log(`Generated verdict lookup: ${Buffer.byteLength(verdicts)} bytes raw, ${gzipSync(verdicts).byteLength} bytes gzip`);
}
