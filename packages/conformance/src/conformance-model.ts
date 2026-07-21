/**
 * The derived, multi-axis conformance read model.
 *
 * Canonical registries, rules-language inventories, and surface contracts are
 * joined here once. Consumer bundles are disposable projections of this model;
 * they never become inputs to another derivation. generate-projections.ts is
 * the executable that writes/checks those projections.
 */
import { surfaceRegistries, type CompatibilityRow, type CompatStatus, type DeveloperSurface, type Surface } from '../registry/index.ts';
import { loadAllSnapshots } from '../rules-language/load.ts';
import type { LanguageConstruct } from '../rules-language/types.ts';
import type { SurfaceCensus } from './surface-census.ts';
import { loadOrBuildSurfaceCensus } from './surface-census-cache.ts';
import {
  deriveAllNodeVerdicts,
  deriveConformanceEvidence,
  type ConformanceVerdict,
} from './conformance-verdicts.ts';
import { surfaceContracts, surfaceDescriptors } from '../surfaces/load.ts';
import type { CapabilityReport } from './rules-language-capability.ts';
import type { CoverageReport } from './rules-language-analyzer.ts';
import {
  deriveFirestoreRulesScorecard,
  type FirestoreRulesScorecard,
} from './firestore-rules-scorecard.ts';
import type { SurfaceDescriptor } from '../surfaces/types.ts';
import type { CompatibilitySurfaceRegistry } from '../registry/types.ts';
import coverageBaselineJson from '../baselines/coverage-baseline.json' with { type: 'json' };
import censusBaselineJson from '../baselines/census-baseline.json' with { type: 'json' };
import { loadObservations, type Observation } from '../observations/load.ts';
import { observationExceptions } from '../exceptions/load.ts';
import { normalizeFeature, resolveCanIUse, type CanIUseOptions, type CanIUseResult } from './can-i-use-query.ts';
import { censusGapProblems, censusIntegrityProblems, type CensusGapBaseline } from './census-policy.ts';
import { workspaceEntryPaths } from './workspace-entry.ts';
import { publicRuntimeExportNamesFromSource } from './public-exports.ts';
import { compatibilitySlug } from './docs-routes.ts';

export type { DeveloperSurface } from '../registry/index.ts';
export const AVAILABILITIES = ['available', 'unavailable', 'deferred', 'out-of-scope'] as const;
export const FIDELITIES = ['conforms', 'diverged', 'bug', 'unsupported', 'unverified', 'not-applicable'] as const;
export const ASSURANCES = ['eligible', 'qualified', 'ineligible', 'not-applicable'] as const;
export type Availability = typeof AVAILABILITIES[number];
export type Fidelity = typeof FIDELITIES[number];
export type Assurance = typeof ASSURANCES[number];
export type FeatureKey = `${DeveloperSurface}/${string}`;
export type ConformanceNodeId = string;
export type FeatureIndex = Readonly<Record<FeatureKey, readonly ConformanceNodeId[]>>;

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
  /** Published package imports through which this feature is exposed. */
  importPaths: readonly string[];
  /** Public docs slug whose generated page explains the evidence. */
  evidenceSlug: string;
  availability: Availability;
  fidelity: Fidelity;
  assurance: Assurance;
  summary: string;
  caveats: readonly string[];
  claims: readonly FeatureClaim[];
}

export interface ImportEvidence {
  importPath: string;
  surface: DeveloperSurface;
  evidenceSlug: string;
}

export interface ConformanceModel {
  supports: readonly FeatureSupport[];
  /** Data-driven API-reference → compatibility-page associations. */
  importEvidence: readonly ImportEvidence[];
  featureIndex: FeatureIndex;
  /** Every addressable claim in the central model, including public-surface facts. */
  nodeVerdicts: Readonly<Record<string, ConformanceVerdict>>;
  /** The evidence-graph subset shipped to the browser assurance adapter. */
  assuranceNodeVerdicts: Readonly<Record<string, ConformanceVerdict>>;
  census: readonly SurfaceCensus[];
  rulesLanguage: {
    capability: CapabilityReport;
    coverage: CoverageReport;
    firestoreScorecard: FirestoreRulesScorecard;
  };
  documentation: {
    registries: readonly CompatibilitySurfaceRegistry[];
    descriptors: readonly SurfaceDescriptor[];
    census: readonly SurfaceCensus[];
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
  importPaths: Set<string>;
  runtimeAvailability?: Availability;
  typeAvailability?: Availability;
  declaredAvailability?: Availability;
  claims: FeatureClaim[];
  registryStatuses: CompatStatus[];
  assuranceVerdicts: ConformanceVerdict[];
  caveats: string[];
}

function featureKey(surface: DeveloperSurface, feature: string): FeatureKey {
  return `${surface}/${feature}`;
}

function rows(): CompatibilityRow[] {
  return surfaceRegistries.flatMap((registry) => registry.blocks.flatMap((block) => block.kind === 'table' ? block.rows : []));
}

/** Derive the canonical user-facing identity from the full construct path.
 * Explicit featureKeys win for exceptional vocabulary such as getAfter. */
export function featureKeysForConstruct(construct: Pick<LanguageConstruct, 'id' | 'kind' | 'featureKeys'>): string[] {
  if (construct.featureKeys?.length) return [...construct.featureKeys];
  const [, encodedKind, ...path] = construct.id.split('.');
  if (encodedKind !== construct.kind || path.length === 0) {
    throw new Error(`Invalid rules construct identity '${construct.id}' for kind '${construct.kind}'`);
  }
  const key = ['binding', 'function', 'method'].includes(construct.kind)
    ? path.join('.')
    : [construct.kind, ...path].join('.');
  return [key];
}

function featureRows(constructFeatures: ReadonlyMap<string, readonly string[]>): Array<{ row: CompatibilityRow; featureKeys: readonly string[] }> {
  return surfaceRegistries.flatMap((registry) => registry.blocks.flatMap((block) => block.kind === 'table'
    ? block.rows.map((row) => ({
        row,
        featureKeys: [...new Set([
          ...row.featureKeys,
          ...(row.constructs ?? []).flatMap((id) => {
            const keys = constructFeatures.get(id);
            if (!keys) throw new Error(`Registry row ${row.id} references unknown rules construct '${id}'`);
            return keys;
          }),
        ])],
      }))
    : []));
}

function fidelityOf(statuses: CompatStatus[]): Fidelity {
  if (statuses.length === 0) return 'not-applicable';
  if (statuses.includes('bug')) return 'bug';
  if (statuses.includes('unsupported')) return 'unsupported';
  if (statuses.includes('diverged-documented')) return 'diverged';
  if (statuses.includes('unverified')) return 'unverified';
  return 'conforms';
}

function assuranceOf(verdicts: ConformanceVerdict[]): Assurance {
  if (verdicts.length === 0) return 'not-applicable';
  if (verdicts.includes('unsupported')) return 'ineligible';
  if (verdicts.includes('qualified')) return 'qualified';
  return 'eligible';
}

function registryStatusOfConstruct(
  status: 'unprobed' | 'accepted' | 'rejected' | 'unprobeable',
  verdict: ConformanceVerdict,
): CompatStatus {
  if (status === 'rejected') return 'diverged-documented';
  if (verdict === 'supported') return 'conforms';
  if (verdict === 'unsupported') return 'unsupported';
  return 'unverified';
}

function availabilityOf(feature: MutableFeature): Availability {
  const availability = feature.runtimeAvailability ?? feature.typeAvailability ?? feature.declaredAvailability;
  if (!availability) throw new Error(`No availability fact for ${feature.surface}/${feature.feature}`);
  return availability;
}

function summarize(feature: MutableFeature, availability: Availability, fidelity: Fidelity, assurance: Assurance): string {
  if (availability !== 'available') {
    return `${feature.feature} is ${availability}; behavior fidelity and assurance are not applicable until the surface exists.`;
  }
  const fidelityText = fidelity === 'not-applicable' ? 'has no applicable behavior claim' : `has ${fidelity} fidelity`;
  const assuranceText = assurance === 'not-applicable' ? 'has no assurance classification' : `is ${assurance} for assurance`;
  return `${feature.feature} is available, ${fidelityText}, and ${assuranceText}.`;
}

let sharedModel: Promise<ConformanceModel> | undefined;

export interface DeriveConformanceModelOptions {
  /** Expose invalid census facts to the blocking census gate so it can report
   * and, for type-only gaps, deliberately update its ratchet baseline. */
  enforceCensusPolicy?: boolean;
}

export function registerImportEvidence(
  target: Map<string, ImportEvidence>,
  next: ImportEvidence,
): void {
  const prior = target.get(next.importPath);
  if (prior && (prior.surface !== next.surface || prior.evidenceSlug !== next.evidenceSlug)) {
    throw new Error(
      `Published import '${next.importPath}' has conflicting evidence associations: ` +
      `${prior.surface}/${prior.evidenceSlug} vs ${next.surface}/${next.evidenceSlug}`,
    );
  }
  target.set(next.importPath, next);
}

/** Derive the immutable read model once per process and share it across every
 * consumer. CI and docs commonly ask several adapters for the same commit's
 * facts; recomputing the live TypeScript census for each adapter adds no trust. */
export function deriveConformanceModel(options: DeriveConformanceModelOptions = {}): Promise<ConformanceModel> {
  if (options.enforceCensusPolicy === false) return buildConformanceModel(false);
  return sharedModel ??= buildConformanceModel(true);
}

async function buildConformanceModel(enforceCensusPolicy: boolean): Promise<ConformanceModel> {
  const census = await loadOrBuildSurfaceCensus();
  const censusProblems = [
    ...censusGapProblems(census, censusBaselineJson as CensusGapBaseline),
    ...censusIntegrityProblems(census),
  ];
  if (enforceCensusPolicy && censusProblems.length > 0) {
    throw new Error(`Conformance model refused invalid public-surface state:\n${censusProblems.map((gap) => `  - ${gap}`).join('\n')}`);
  }
  const evidence = await deriveConformanceEvidence();
  const verdicts = deriveAllNodeVerdicts(evidence.graph);
  const surfaceVerdicts: Record<string, ConformanceVerdict> = {};
  const snapshots = Object.values(loadAllSnapshots());
  const firestoreSnapshot = snapshots.find(({ engine }) => engine === 'firestore');
  const firestoreCapability = evidence.capabilityReport.engines.find(({ engine }) => engine === 'firestore');
  const firestoreCoverage = evidence.coverageReport.engines.find(({ engine }) => engine === 'firestore');
  if (!firestoreSnapshot || !firestoreCapability || !firestoreCoverage) {
    throw new Error('Firestore Rules scorecard inputs are missing from the central conformance model');
  }
  const firestoreScorecard = deriveFirestoreRulesScorecard({
    constructs: firestoreSnapshot.constructs,
    capabilities: firestoreCapability.constructs,
    coverage: firestoreCoverage.constructs,
  });
  const constructFeatures = new Map(snapshots.flatMap(({ constructs }) =>
    constructs.map((construct) => [construct.id, featureKeysForConstruct(construct)] as const),
  ));
  const features = new Map<string, MutableFeature>();
  const developerSurfaceByContract = new Map(surfaceContracts.map(({ key, record }) =>
    [key, record.developerSurface] as const,
  ));
  const contractByKey = new Map(surfaceContracts.map(({ key, record }) => [key, record] as const));
  const importsByContract = new Map<string, readonly string[]>();
  const runtimeExportsByContract = new Map<string, ReadonlySet<string>>();
  for (const { key, record } of surfaceContracts) {
    const imports = record.kind === 'mirror' || record.kind === 'census-only'
      ? record.mirrors
      : record.kind === 'native'
        ? [record.symbolSource]
        : record.kind === 'registry-only'
          ? record.evidenceImports ?? []
          : [];
    for (const importPath of imports) {
      const entry = workspaceEntryPaths(importPath);
      if (!entry) {
        throw new Error(`Surface contract '${key}' names unpublished import '${importPath}'`);
      }
      if (record.kind === 'native') {
        runtimeExportsByContract.set(key, new Set(publicRuntimeExportNamesFromSource(entry.source)));
      }
    }
    importsByContract.set(key, [...new Set(imports)].sort());
  }
  const evidenceSlugByDeveloperSurface = new Map<DeveloperSurface, string>();
  for (const descriptor of surfaceDescriptors) {
    const surface = descriptor.developerSurface;
    const slug = compatibilitySlug(descriptor.compatPath);
    const prior = evidenceSlugByDeveloperSurface.get(surface);
    if (prior && prior !== slug) {
      throw new Error(`Conflicting evidence pages for developer surface '${surface}': ${prior} vs ${slug}`);
    }
    evidenceSlugByDeveloperSurface.set(surface, slug);
  }
  const importEvidenceByPath = new Map<string, ImportEvidence>();
  for (const { key, record } of surfaceContracts) {
    const imports = record.kind === 'mirror' || record.kind === 'census-only'
      ? record.mirrors
      : record.evidenceImports ?? [];
    const surface = record.developerSurface;
    const evidenceSlug = evidenceSlugByDeveloperSurface.get(surface);
    if (!evidenceSlug) throw new Error(`No evidence page for developer surface '${surface}'`);
    for (const importPath of imports) {
      if (!workspaceEntryPaths(importPath)) throw new Error(`Surface contract '${key}' names unpublished evidence import '${importPath}'`);
      const next = { importPath, surface, evidenceSlug };
      registerImportEvidence(importEvidenceByPath, next);
    }
  }
  const censusOwner = new Map(surfaceContracts.flatMap(({ key, record }) =>
    (record.kind === 'mirror' && record.coverage) || record.kind === 'census-only'
      ? [[record.censusSurface, key] as const]
      : [],
  ));
  const developerSurfaceFor = (surface: Surface | string): DeveloperSurface => {
    const owner = developerSurfaceByContract.get(surface);
    if (!owner) throw new Error(`No developerSurface contract for registry surface '${surface}'`);
    return owner;
  };

  const ensure = (name: string, surface: DeveloperSurface): MutableFeature => {
    const key = featureKey(surface, name);
    const existing = features.get(key);
    if (existing) {
      if (/^[a-z]/.test(name) && /^[A-Z]/.test(existing.feature)) existing.feature = name;
      return existing;
    }
    const created: MutableFeature = {
      feature: name, surface, importPaths: new Set(), claims: [], registryStatuses: [], assuranceVerdicts: [], caveats: [],
    };
    features.set(key, created);
    return created;
  };

  const addImportPaths = (feature: MutableFeature, contract: string): void => {
    const importPaths = importsByContract.get(contract);
    if (!importPaths) throw new Error(`No surface contract for '${contract}'`);
    for (const importPath of importPaths) feature.importPaths.add(importPath);
  };

  const classify = (feature: MutableFeature, axis: 'runtime' | 'type' | 'declared', availability: Availability): void => {
    const field = axis === 'runtime' ? 'runtimeAvailability' : axis === 'type' ? 'typeAvailability' : 'declaredAvailability';
    const current = feature[field];
    if (current && current !== availability) {
      throw new Error(`Conflicting ${axis} availability for ${feature.surface}/${feature.feature}: ${current} vs ${availability}`);
    }
    feature[field] = availability;
  };

  for (const entry of census) {
    const contract = censusOwner.get(entry.surface) ?? entry.surface;
    const surface = developerSurfaceFor(contract);
    for (const symbol of entry.runtime.mapped) {
      const feature = ensure(symbol, surface);
      addImportPaths(feature, contract);
      classify(feature, 'runtime', 'available');
      surfaceVerdicts[`${entry.surface}:runtime:${symbol}`] = 'supported';
      feature.claims.push({
        id: `${entry.surface}:runtime:${symbol}`, kind: 'runtime-export', surface: entry.surface,
        behavior: `${symbol} is exported by the Pyric mirror`, status: 'mapped', evidence: [], assurance: 'not-applicable',
      });
    }
    for (const disposition of entry.runtime.dispositioned) {
      const feature = ensure(disposition.symbol, surface);
      addImportPaths(feature, contract);
      classify(feature, 'runtime', disposition.availability);
      surfaceVerdicts[`${entry.surface}:runtime:${disposition.symbol}`] = 'unsupported';
      feature.caveats.push(disposition.summary);
      feature.claims.push({
        id: `${entry.surface}:runtime:${disposition.symbol}`, kind: 'runtime-export', surface: entry.surface,
        behavior: disposition.summary, status: disposition.availability, evidence: disposition.evidenceRefs, assurance: 'not-applicable',
      });
    }
    for (const symbol of entry.runtime.unmapped) {
      if (enforceCensusPolicy) {
        throw new Error(`Unclassified public runtime export reached the query model: ${entry.surface}/${symbol}`);
      }
    }
    for (const symbol of entry.types.mapped) {
      const feature = ensure(symbol, surface);
      addImportPaths(feature, contract);
      classify(feature, 'type', 'available');
      surfaceVerdicts[`${entry.surface}:type:${symbol}`] = 'supported';
      feature.claims.push({
        id: `${entry.surface}:type:${symbol}`, kind: 'type-export', surface: entry.surface,
        behavior: `${symbol} is exported in the Pyric type namespace`, status: 'mapped', evidence: [], assurance: 'not-applicable',
      });
    }
    for (const symbol of entry.types.unmapped) {
      // A known public type gap is still a developer-facing availability fact.
      // Keep it queryable even when no runtime or behavior claim shares its name.
      const feature = ensure(symbol, surface);
      addImportPaths(feature, contract);
      classify(feature, 'type', 'unavailable');
      surfaceVerdicts[`${entry.surface}:type:${symbol}`] = 'unsupported';
      feature.caveats.push('Public type export is not mirrored.');
      feature.claims.push({
        id: `${entry.surface}:type:${symbol}`, kind: 'type-export', surface: entry.surface,
        behavior: `${symbol} is missing from the Pyric type namespace`, status: 'unmapped', evidence: [], assurance: 'not-applicable',
      });
    }
  }

  for (const { row, featureKeys } of featureRows(constructFeatures)) {
    const rowVerdict = verdicts[row.id];
    for (const name of featureKeys) {
      const feature = ensure(name, developerSurfaceFor(row.surface));
      if (
        runtimeExportsByContract.get(row.surface)?.has(name)
        || contractByKey.get(row.surface)?.kind === 'registry-only'
      ) {
        addImportPaths(feature, row.surface);
      }
      classify(feature, 'declared', 'available');
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

  for (const snapshot of snapshots) {
    for (const construct of snapshot.constructs) {
      const names = constructFeatures.get(construct.id)!;
      const verdict = verdicts[construct.id];
      const contract = `${construct.engine}-rules`;
      for (const name of names) {
        const feature = ensure(name, developerSurfaceFor(contract));
        classify(feature, 'declared', 'available');
        if (!verdict) throw new Error(`No graph verdict for rules construct '${construct.id}'`);
        feature.registryStatuses.push(registryStatusOfConstruct(construct.status, verdict));
        if (verdict) feature.assuranceVerdicts.push(verdict);
        if (construct.note) feature.caveats.push(construct.note);
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
    const availability = availabilityOf(feature);
    const fidelity = availability === 'available' ? fidelityOf(feature.registryStatuses) : 'not-applicable';
    const assurance = availability === 'available' ? assuranceOf(feature.assuranceVerdicts) : 'not-applicable';
    const evidenceSlug = evidenceSlugByDeveloperSurface.get(feature.surface);
    if (!evidenceSlug) throw new Error(`No evidence page for developer surface '${feature.surface}'`);
    return {
      feature: feature.feature,
      surface: feature.surface,
      importPaths: [...feature.importPaths].sort(),
      evidenceSlug,
      availability,
      fidelity,
      assurance,
      summary: summarize(feature, availability, fidelity, assurance),
      caveats: [...new Set(feature.caveats)],
      claims: feature.claims.sort((a, b) => a.id.localeCompare(b.id)),
    };
  }).sort((a, b) => normalizeFeature(a.feature).localeCompare(normalizeFeature(b.feature)) || a.surface.localeCompare(b.surface));
  const nodeVerdicts = { ...verdicts, ...surfaceVerdicts };
  const featureIndex = Object.fromEntries(supports.map((support) => [
    featureKey(support.surface, support.feature),
    support.claims.map(({ id }) => id),
  ])) as FeatureIndex;
  return {
    supports,
    importEvidence: [...importEvidenceByPath.values()].sort((a, b) => a.importPath.localeCompare(b.importPath)),
    featureIndex,
    nodeVerdicts,
    assuranceNodeVerdicts: verdicts,
    census,
    rulesLanguage: {
      capability: evidence.capabilityReport,
      coverage: evidence.coverageReport,
      firestoreScorecard,
    },
    documentation: {
      registries: surfaceRegistries,
      descriptors: surfaceDescriptors,
      census,
      coverageBaseline: coverageBaselineJson as CoverageBaseline,
      rows: rows(),
    },
    evidence: {
      observations: loadObservations(),
      observationExceptions,
    },
  };
}

export function canIUse(model: ConformanceModel, query: string, options?: CanIUseOptions): CanIUseResult<FeatureSupport> {
  return resolveCanIUse(model.supports, query, options);
}
