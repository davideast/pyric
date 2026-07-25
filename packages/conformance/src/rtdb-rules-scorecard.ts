import { createHash } from 'node:crypto';
import type { LanguageConstruct } from '../rules-language/types.ts';
import { loadSnapshot } from '../rules-language/load.ts';
import {
  computeCapabilityReport,
  type ConstructCapability,
} from './rules-language-capability.ts';
import {
  computeCoverageReport,
  type ConstructCoverage,
} from './rules-language-coverage.ts';
import { loadAndValidateRtdbAcceptanceEvidence } from './rtdb-rules-acceptance-evidence.ts';

export const RTDB_SCORE_CLASSIFICATIONS = [
  'conformant',
  'diverged',
  'unknown',
  'local-unsupported',
  'local-error',
  'unprobeable',
] as const;

export type RtdbScoreClassification = typeof RTDB_SCORE_CLASSIFICATIONS[number];
export type RtdbLocalAcceptance = 'accepted' | 'rejected' | 'unsupported' | 'unprobeable';

export interface RtdbConstructScore {
  id: string;
  kind: LanguageConstruct['kind'];
  productionAcceptance: LanguageConstruct['status'];
  localAcceptance: RtdbLocalAcceptance;
  localCapability: ConstructCapability['classification'];
  productionEvidence: ConstructCoverage['verdict'];
  classification: RtdbScoreClassification;
  verifiedBy: readonly string[];
  verifiedByRows: readonly string[];
  divergedByRows: readonly string[];
}

export interface RtdbRulesScorecard {
  schema: 'pyric.conformance.rtdb-rules-scorecard.v1';
  engine: 'rtdb';
  universe: {
    hashAlgorithm: 'sha256';
    hash: string;
    denominator: number;
    constructIds: readonly string[];
  };
  score: {
    numerator: number;
    denominator: number;
    ratio: number;
    percent: number;
  };
  axes: {
    productionAcceptance: Readonly<Record<LanguageConstruct['status'], number>>;
    localAcceptance: Readonly<Record<RtdbLocalAcceptance, number>>;
    localCapability: Readonly<Record<ConstructCapability['classification'], number>>;
    productionEvidence: Readonly<Record<ConstructCoverage['verdict'], number>>;
  };
  counts: Readonly<Record<RtdbScoreClassification, number>>;
  constructs: readonly RtdbConstructScore[];
}

export interface RtdbScorecardInput {
  constructs: readonly LanguageConstruct[];
  capabilities: readonly ConstructCapability[];
  coverage: readonly ConstructCoverage[];
}

export function rtdbUniverseHash(ids: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(ids)).digest('hex');
}

function classify(
  construct: LanguageConstruct,
  capability: ConstructCapability,
  coverage: ConstructCoverage,
): RtdbScoreClassification {
  if (coverage.verdict === 'diverged') return 'diverged';
  if (construct.status === 'unprobed') return 'unknown';
  if (construct.status === 'unprobeable' || capability.classification === 'unprobeable') {
    return 'unprobeable';
  }
  if (capability.classification === 'unsupported') return 'local-unsupported';
  if (capability.classification === 'error') return 'local-error';
  if (coverage.verdict === 'unverified' && !construct.unattributable) return 'unknown';
  return 'conformant';
}

function localAcceptance(capability: ConstructCapability): RtdbLocalAcceptance {
  switch (capability.classification) {
    case 'implemented': return 'accepted';
    case 'error': return 'rejected';
    case 'unsupported': return 'unsupported';
    case 'unprobeable': return 'unprobeable';
  }
}

export function deriveRtdbRulesScorecard(
  input: RtdbScorecardInput,
): RtdbRulesScorecard {
  const ids = input.constructs.map(({ id }) => id);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) throw new Error('RTDB score universe contains duplicate construct ids');

  const capabilities = new Map(input.capabilities.map((entry) => [entry.id, entry]));
  const coverage = new Map(input.coverage.map((entry) => [entry.id, entry]));

  const constructs = input.constructs.map((construct): RtdbConstructScore => {
    const capability = capabilities.get(construct.id);
    const evidence = coverage.get(construct.id);
    if (!capability || !evidence) {
      throw new Error(`RTDB score input is incomplete for ${construct.id}`);
    }
    return {
      id: construct.id,
      kind: construct.kind,
      productionAcceptance: construct.status,
      localAcceptance: localAcceptance(capability),
      localCapability: capability.classification,
      productionEvidence: evidence.verdict,
      classification: classify(construct, capability, evidence),
      verifiedBy: [...evidence.verifiedBy],
      verifiedByRows: [...evidence.verifiedByRows],
      divergedByRows: [...(evidence.divergedByRows ?? [])],
    };
  });

  const counts = Object.fromEntries(
    RTDB_SCORE_CLASSIFICATIONS.map((classification) => [
      classification,
      constructs.filter((construct) => construct.classification === classification).length,
    ]),
  ) as Record<RtdbScoreClassification, number>;
  const denominator = constructs.length;
  const numerator = counts.conformant;
  const countValues = <T extends string>(values: readonly T[], universe: readonly T[]): Record<T, number> =>
    Object.fromEntries(universe.map((value) => [value, values.filter((entry) => entry === value).length])) as Record<T, number>;

  return {
    schema: 'pyric.conformance.rtdb-rules-scorecard.v1',
    engine: 'rtdb',
    universe: {
      hashAlgorithm: 'sha256',
      hash: rtdbUniverseHash(ids),
      denominator,
      constructIds: ids,
    },
    score: {
      numerator,
      denominator,
      ratio: denominator === 0 ? 0 : numerator / denominator,
      percent: denominator === 0 ? 0 : Math.round((numerator / denominator) * 1000) / 10,
    },
    axes: {
      productionAcceptance: countValues(
        constructs.map(({ productionAcceptance }) => productionAcceptance),
        ['unprobed', 'accepted', 'rejected', 'unprobeable'],
      ),
      localAcceptance: countValues(
        constructs.map(({ localAcceptance }) => localAcceptance),
        ['accepted', 'rejected', 'unsupported', 'unprobeable'],
      ),
      localCapability: countValues(
        constructs.map(({ localCapability }) => localCapability),
        ['implemented', 'unsupported', 'error', 'unprobeable'],
      ),
      productionEvidence: countValues(
        constructs.map(({ productionEvidence }) => productionEvidence),
        ['verified', 'diverged', 'unverified'],
      ),
    },
    counts,
    constructs,
  };
}

export async function computeRtdbRulesScorecard(): Promise<RtdbRulesScorecard> {
  const snapshot = loadSnapshot('rtdb');
  loadAndValidateRtdbAcceptanceEvidence(snapshot.constructs);
  const capability = computeCapabilityReport().engines.find((entry) => entry.engine === 'rtdb');
  const coverage = (await computeCoverageReport()).engines.find((entry) => entry.engine === 'rtdb');
  if (!capability || !coverage) throw new Error('RTDB reports are missing from the conformance model');
  return deriveRtdbRulesScorecard({
    constructs: snapshot.constructs,
    capabilities: capability.constructs,
    coverage: coverage.constructs,
  });
}
