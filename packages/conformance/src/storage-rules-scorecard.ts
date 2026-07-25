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
import { loadAndValidateStorageAcceptanceEvidence } from './storage-rules-acceptance-evidence.ts';
import { rejectionSignature } from './firestore-rules-scorecard.ts';

export const STORAGE_SCORE_CLASSIFICATIONS = [
  'conformant',
  'diverged',
  'unknown',
  'acceptance-mismatch',
  'local-unsupported',
  'local-error',
  'unprobeable',
] as const;

export type StorageScoreClassification = typeof STORAGE_SCORE_CLASSIFICATIONS[number];
export type StorageLocalAcceptance = 'accepted' | 'rejected' | 'unsupported' | 'unprobeable';

export interface StorageConstructScore {
  id: string;
  kind: LanguageConstruct['kind'];
  productionAcceptance: LanguageConstruct['status'];
  localAcceptance: StorageLocalAcceptance;
  productionRejectionSignature?: string;
  localRejectionSignature?: string;
  localCapability: ConstructCapability['classification'];
  productionProbeDigest?: string;
  currentProbeDigest?: string;
  acceptanceProbeBound: boolean;
  productionEvaluationAgreement?: boolean;
  localEvaluationAgreement?: boolean;
  productionEvidence: ConstructCoverage['verdict'];
  classification: StorageScoreClassification;
  verifiedBy: readonly string[];
  verifiedByRows: readonly string[];
  divergedByRows: readonly string[];
}

export interface StorageRulesScorecard {
  schema: 'pyric.conformance.storage-rules-scorecard.v1';
  engine: 'storage';
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
    localAcceptance: Readonly<Record<StorageLocalAcceptance, number>>;
    localCapability: Readonly<Record<ConstructCapability['classification'], number>>;
    productionEvidence: Readonly<Record<ConstructCoverage['verdict'], number>>;
  };
  counts: Readonly<Record<StorageScoreClassification, number>>;
  constructs: readonly StorageConstructScore[];
}

export interface StorageScorecardInput {
  constructs: readonly LanguageConstruct[];
  capabilities: readonly ConstructCapability[];
  coverage: readonly ConstructCoverage[];
}

export function storageUniverseHash(ids: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(ids)).digest('hex');
}

function classify(
  construct: LanguageConstruct,
  capability: ConstructCapability,
  coverage: ConstructCoverage,
): StorageScoreClassification {
  if (coverage.verdict === 'diverged') return 'diverged';
  const acceptanceProbeBound = construct.probeDigest?.algorithm === 'sha256' &&
    construct.probeDigest.value === capability.probeDigest?.value;
  if ((construct.status === 'accepted' || construct.status === 'rejected') && !acceptanceProbeBound) {
    return 'unknown';
  }
  if (construct.status === 'unprobed') return 'unknown';
  if (construct.status === 'unprobeable' || capability.classification === 'unprobeable') {
    return 'unprobeable';
  }
  if (construct.status === 'rejected') {
    if (capability.classification !== 'error') return 'acceptance-mismatch';
    const productionSignature = rejectionSignature(construct.probeNote);
    const localSignature = rejectionSignature(capability.detail);
    if (!productionSignature || productionSignature !== localSignature) return 'acceptance-mismatch';
    return coverage.verdict === 'verified' ? 'conformant' : 'unknown';
  }
  if (capability.classification === 'unsupported') return 'local-unsupported';
  if (capability.classification === 'error') return 'local-error';
  if (construct.status === 'accepted' &&
      (construct.probeEvaluationAgreement !== true || capability.evaluationAgreement !== true)) {
    return 'acceptance-mismatch';
  }
  if (coverage.verdict === 'unverified' && !construct.unattributable) return 'unknown';
  return 'conformant';
}

function localAcceptance(capability: ConstructCapability): StorageLocalAcceptance {
  switch (capability.classification) {
    case 'implemented': return 'accepted';
    case 'error': return 'rejected';
    case 'unsupported': return 'unsupported';
    case 'unprobeable': return 'unprobeable';
  }
}

export function deriveStorageRulesScorecard(
  input: StorageScorecardInput,
): StorageRulesScorecard {
  const ids = input.constructs.map(({ id }) => id);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) throw new Error('Storage score universe contains duplicate construct ids');

  const capabilities = new Map(input.capabilities.map((entry) => [entry.id, entry]));
  const coverage = new Map(input.coverage.map((entry) => [entry.id, entry]));

  const constructs = input.constructs.map((construct): StorageConstructScore => {
    const capability = capabilities.get(construct.id);
    const evidence = coverage.get(construct.id);
    if (!capability || !evidence) {
      throw new Error(`Storage score input is incomplete for ${construct.id}`);
    }
    const productionRejectionSignature = rejectionSignature(construct.probeNote);
    const localRejectionSignature = rejectionSignature(capability.detail);
    return {
      id: construct.id,
      kind: construct.kind,
      productionAcceptance: construct.status,
      localAcceptance: localAcceptance(capability),
      ...(productionRejectionSignature ? { productionRejectionSignature } : {}),
      ...(localRejectionSignature ? { localRejectionSignature } : {}),
      localCapability: capability.classification,
      ...(construct.probeDigest ? { productionProbeDigest: construct.probeDigest.value } : {}),
      ...(capability.probeDigest ? { currentProbeDigest: capability.probeDigest.value } : {}),
      acceptanceProbeBound: construct.probeDigest?.algorithm === 'sha256' &&
        construct.probeDigest.value === capability.probeDigest?.value,
      ...(construct.probeEvaluationAgreement !== undefined
        ? { productionEvaluationAgreement: construct.probeEvaluationAgreement } : {}),
      ...(capability.evaluationAgreement !== undefined
        ? { localEvaluationAgreement: capability.evaluationAgreement } : {}),
      productionEvidence: evidence.verdict,
      classification: classify(construct, capability, evidence),
      verifiedBy: [...evidence.verifiedBy],
      verifiedByRows: [...evidence.verifiedByRows],
      divergedByRows: [...(evidence.divergedByRows ?? [])],
    };
  });

  const counts = Object.fromEntries(
    STORAGE_SCORE_CLASSIFICATIONS.map((classification) => [
      classification,
      constructs.filter((construct) => construct.classification === classification).length,
    ]),
  ) as Record<StorageScoreClassification, number>;
  const denominator = constructs.length;
  const numerator = counts.conformant;
  const countValues = <T extends string>(values: readonly T[], universe: readonly T[]): Record<T, number> =>
    Object.fromEntries(universe.map((value) => [value, values.filter((entry) => entry === value).length])) as Record<T, number>;

  return {
    schema: 'pyric.conformance.storage-rules-scorecard.v1',
    engine: 'storage',
    universe: {
      hashAlgorithm: 'sha256',
      hash: storageUniverseHash(ids),
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

export async function computeStorageRulesScorecard(): Promise<StorageRulesScorecard> {
  const snapshot = loadSnapshot('storage');
  loadAndValidateStorageAcceptanceEvidence(snapshot.constructs);
  const capability = computeCapabilityReport().engines.find((entry) => entry.engine === 'storage');
  const coverage = (await computeCoverageReport()).engines.find((entry) => entry.engine === 'storage');
  if (!capability || !coverage) throw new Error('Storage reports are missing from the conformance model');
  return deriveStorageRulesScorecard({
    constructs: snapshot.constructs,
    capabilities: capability.constructs,
    coverage: coverage.constructs,
  });
}
