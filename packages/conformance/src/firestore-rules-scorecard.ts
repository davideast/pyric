/**
 * Canonical Firestore Security Rules conformance scorecard.
 *
 * The score is deliberately stricter than either rules-language report:
 * production acceptance, local capability, and production-backed behavioral
 * evidence must all agree before a construct is conformant. Every construct in
 * the committed Firestore language inventory stays in the denominator.
 */
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
} from './rules-language-analyzer.ts';

export const FIRESTORE_SCORE_CLASSIFICATIONS = [
  'conformant',
  'diverged',
  'unknown',
  'acceptance-mismatch',
  'local-unsupported',
  'local-error',
  'unprobeable',
] as const;

export type FirestoreScoreClassification = typeof FIRESTORE_SCORE_CLASSIFICATIONS[number];
export type FirestoreLocalAcceptance = 'accepted' | 'rejected' | 'unsupported' | 'unprobeable';

export interface FirestoreConstructScore {
  id: string;
  kind: LanguageConstruct['kind'];
  productionAcceptance: LanguageConstruct['status'];
  localAcceptance: FirestoreLocalAcceptance;
  productionRejectionSignature?: string;
  localRejectionSignature?: string;
  localCapability: ConstructCapability['classification'];
  productionProbeDigest?: string;
  currentProbeDigest?: string;
  acceptanceProbeBound: boolean;
  productionEvidence: ConstructCoverage['verdict'];
  classification: FirestoreScoreClassification;
  verifiedBy: readonly string[];
  verifiedByRows: readonly string[];
  divergedByRows: readonly string[];
}

export interface FirestoreRulesScorecard {
  schema: 'pyric.conformance.firestore-rules-scorecard.v1';
  engine: 'firestore';
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
    localAcceptance: Readonly<Record<FirestoreLocalAcceptance, number>>;
    localCapability: Readonly<Record<ConstructCapability['classification'], number>>;
    productionEvidence: Readonly<Record<ConstructCoverage['verdict'], number>>;
  };
  counts: Readonly<Record<FirestoreScoreClassification, number>>;
  constructs: readonly FirestoreConstructScore[];
}

export interface FirestoreScorecardInput {
  constructs: readonly LanguageConstruct[];
  capabilities: readonly ConstructCapability[];
  coverage: readonly ConstructCoverage[];
}

/** Hash the ordered universe, including separators through JSON encoding. */
export function firestoreUniverseHash(ids: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(ids)).digest('hex');
}

function classify(
  construct: LanguageConstruct,
  capability: ConstructCapability,
  coverage: ConstructCoverage,
): FirestoreScoreClassification {
  // Negative production evidence dominates every positive path.
  if (coverage.verdict === 'diverged') return 'diverged';
  const acceptanceProbeBound = construct.probeDigest?.algorithm === 'sha256' &&
    construct.probeDigest.value === capability.probeDigest?.value;
  if ((construct.status === 'accepted' || construct.status === 'rejected') && !acceptanceProbeBound) {
    return 'unknown';
  }
  // Acceptance must be known on both sides. `unprobed` can never receive
  // conformance credit, even if capability and behavioral evidence are green.
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
  if (coverage.verdict === 'unverified') return 'unknown';
  if (construct.id === 'firestore.semantic.hierarchical-match-cascade' && coverage.verifiedByRows.length === 0) {
    return 'unknown';
  }
  return 'conformant';
}

/** Normalize the two engines' prose into a comparable rejection boundary. */
export function rejectionSignature(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const productionField = detail.match(/Property ([A-Za-z_][\w]*) is undefined on object/);
  if (productionField) return `undefined-field:${productionField[1]}`;
  const localField = detail.match(/No field '([^']+)' on map/);
  if (localField) return `undefined-field:${localField[1]}`;
  const productionFunction = detail.match(/Function not found error: Name: \[([^\]]+)\]/);
  if (productionFunction) return `function-not-found:${productionFunction[1]}`;
  const localFunction = detail.match(/Unknown function: ([^\s]+)/);
  if (localFunction) return `function-not-found:${localFunction[1]}`;
  return undefined;
}

function localAcceptance(capability: ConstructCapability): FirestoreLocalAcceptance {
  switch (capability.classification) {
    case 'implemented': return 'accepted';
    case 'error': return 'rejected';
    case 'unsupported': return 'unsupported';
    case 'unprobeable': return 'unprobeable';
  }
}

export function deriveFirestoreRulesScorecard(
  input: FirestoreScorecardInput,
): FirestoreRulesScorecard {
  const ids = input.constructs.map(({ id }) => id);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) throw new Error('Firestore score universe contains duplicate construct ids');
  const duplicateIds = (values: readonly { id: string }[]): string[] => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const { id } of values) {
      if (seen.has(id)) duplicates.add(id);
      seen.add(id);
    }
    return [...duplicates].sort();
  };
  for (const [label, values] of [
    ['capability', input.capabilities],
    ['coverage', input.coverage],
  ] as const) {
    const duplicates = duplicateIds(values);
    if (duplicates.length > 0) {
      throw new Error(`Firestore score ${label} input contains duplicate ids: ${duplicates.join(', ')}`);
    }
  }

  const capabilities = new Map(input.capabilities.map((entry) => [entry.id, entry]));
  const coverage = new Map(input.coverage.map((entry) => [entry.id, entry]));
  const extras = [
    ...input.capabilities.filter(({ id }) => !uniqueIds.has(id)).map(({ id }) => `capability:${id}`),
    ...input.coverage.filter(({ id }) => !uniqueIds.has(id)).map(({ id }) => `coverage:${id}`),
  ];
  if (extras.length > 0) throw new Error(`Firestore score inputs contain ids outside the universe: ${extras.join(', ')}`);

  const constructs = input.constructs.map((construct): FirestoreConstructScore => {
    const capability = capabilities.get(construct.id);
    const evidence = coverage.get(construct.id);
    if (!capability || !evidence) {
      throw new Error(
        `Firestore score input is incomplete for ${construct.id}: ` +
        `${capability ? '' : 'missing capability'}${!capability && !evidence ? ', ' : ''}${evidence ? '' : 'missing coverage'}`,
      );
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
      productionEvidence: evidence.verdict,
      classification: classify(construct, capability, evidence),
      verifiedBy: [...evidence.verifiedBy],
      verifiedByRows: [...evidence.verifiedByRows],
      divergedByRows: [...(evidence.divergedByRows ?? [])],
    };
  });

  const counts = Object.fromEntries(
    FIRESTORE_SCORE_CLASSIFICATIONS.map((classification) => [
      classification,
      constructs.filter((construct) => construct.classification === classification).length,
    ]),
  ) as Record<FirestoreScoreClassification, number>;
  const denominator = constructs.length;
  const numerator = counts.conformant;
  const countValues = <T extends string>(values: readonly T[], universe: readonly T[]): Record<T, number> =>
    Object.fromEntries(universe.map((value) => [value, values.filter((entry) => entry === value).length])) as Record<T, number>;

  return {
    schema: 'pyric.conformance.firestore-rules-scorecard.v1',
    engine: 'firestore',
    universe: {
      hashAlgorithm: 'sha256',
      hash: firestoreUniverseHash(ids),
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
        constructs.map(({ localAcceptance: acceptance }) => acceptance),
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

export async function computeFirestoreRulesScorecard(): Promise<FirestoreRulesScorecard> {
  const snapshot = loadSnapshot('firestore');
  const capability = computeCapabilityReport().engines.find((entry) => entry.engine === 'firestore');
  const coverage = (await computeCoverageReport()).engines.find((entry) => entry.engine === 'firestore');
  if (!capability || !coverage) throw new Error('Firestore reports are missing from the conformance model');
  return deriveFirestoreRulesScorecard({
    constructs: snapshot.constructs,
    capabilities: capability.constructs,
    coverage: coverage.constructs,
  });
}
