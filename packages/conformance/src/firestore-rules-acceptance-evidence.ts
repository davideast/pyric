import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageConstruct } from '../rules-language/types.ts';
import { resolveFirestoreConstructProbe } from './rules-language-capability.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIRESTORE_ACCEPTANCE_EVIDENCE_PATH = join(
  HERE,
  '..',
  'rules-language',
  'firestore-acceptance-evidence.json',
);

export interface FirestoreAcceptanceEvidenceConstruct {
  id: string;
  kind: string;
  status: LanguageConstruct['status'];
  probeNote?: string;
  probeDigest?: { algorithm: 'sha256'; value: string };
  evaluationAgreement?: boolean;
  evaluationDetail?: string;
  expectedDecision?: 'ALLOW' | 'DENY';
  actualDecision?: 'ALLOW' | 'DENY';
}

export interface FirestoreAcceptanceEvidence {
  schema: 'pyric.conformance.firestore-rules-acceptance-evidence.v1';
  capturedAt: string;
  projectId: string;
  engine: 'firestore';
  total: number;
  constructs: FirestoreAcceptanceEvidenceConstruct[];
}

interface CanonicalProbeFact {
  expectedDecision?: 'ALLOW' | 'DENY';
  unprobeableReason?: string;
}

/** Bind the compact snapshot claims to the committed, inspectable capture. */
export function validateFirestoreAcceptanceEvidence(
  snapshot: readonly LanguageConstruct[],
  evidence: FirestoreAcceptanceEvidence,
  canonicalProbe: (construct: LanguageConstruct) => CanonicalProbeFact,
): void {
  if (evidence.schema !== 'pyric.conformance.firestore-rules-acceptance-evidence.v1' ||
      evidence.engine !== 'firestore' || !evidence.projectId || Number.isNaN(Date.parse(evidence.capturedAt))) {
    throw new Error('Firestore acceptance evidence metadata is invalid');
  }
  if (evidence.total !== snapshot.length || evidence.constructs.length !== snapshot.length) {
    throw new Error(
      `Firestore acceptance evidence universe mismatch: expected ${snapshot.length}, got ` +
      `${evidence.total}/${evidence.constructs.length}`,
    );
  }
  const byId = new Map<string, FirestoreAcceptanceEvidenceConstruct>();
  for (const row of evidence.constructs) {
    if (byId.has(row.id)) throw new Error(`Firestore acceptance evidence duplicates ${row.id}`);
    byId.set(row.id, row);
  }
  for (const construct of snapshot) {
    const row = byId.get(construct.id);
    if (!row) throw new Error(`Firestore acceptance evidence is missing ${construct.id}`);
    if (row.kind !== construct.kind || row.status !== construct.status) {
      throw new Error(`Firestore acceptance evidence status/kind mismatch for ${construct.id}`);
    }
    if (JSON.stringify(row.probeDigest) !== JSON.stringify(construct.probeDigest)) {
      throw new Error(`Firestore acceptance evidence probe digest mismatch for ${construct.id}`);
    }
    if (row.evaluationAgreement !== construct.probeEvaluationAgreement) {
      throw new Error(`Firestore acceptance evidence agreement mismatch for ${construct.id}`);
    }
    if (row.probeNote !== construct.probeNote) {
      throw new Error(`Firestore acceptance evidence probe note mismatch for ${construct.id}`);
    }
    if ((row.status === 'rejected' || row.status === 'unprobeable') && !row.probeNote) {
      throw new Error(`Firestore acceptance evidence note is missing for ${construct.id}`);
    }
    const canonical = canonicalProbe(construct);
    if (row.status === 'unprobeable' && row.probeNote !== canonical.unprobeableReason) {
      throw new Error(`Firestore acceptance evidence unprobeable reason mismatch for ${construct.id}`);
    }
    if (row.status === 'accepted') {
      if (!row.probeDigest || row.expectedDecision === undefined || row.actualDecision === undefined ||
          row.evaluationAgreement !== (row.expectedDecision === row.actualDecision) ||
          row.expectedDecision !== canonical.expectedDecision ||
          row.evaluationDetail !== `expected ${row.expectedDecision}, got ${row.actualDecision}`) {
        throw new Error(`Firestore acceptance evidence decisions are invalid for ${construct.id}`);
      }
    }
  }
}

export function loadAndValidateFirestoreAcceptanceEvidence(
  snapshot: readonly LanguageConstruct[],
): FirestoreAcceptanceEvidence {
  const evidence = JSON.parse(readFileSync(FIRESTORE_ACCEPTANCE_EVIDENCE_PATH, 'utf8')) as FirestoreAcceptanceEvidence;
  validateFirestoreAcceptanceEvidence(snapshot, evidence, (construct) => {
    const probe = resolveFirestoreConstructProbe(construct);
    if ('unprobeable' in probe) return { unprobeableReason: probe.unprobeable };
    if (probe.cases.length !== 1 || !probe.cases[0]?.expectation) {
      throw new Error(`Firestore canonical probe must define exactly one expectation for ${construct.id}`);
    }
    return { expectedDecision: probe.cases[0].expectation };
  });
  return evidence;
}
