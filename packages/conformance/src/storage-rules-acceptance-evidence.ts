import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageConstruct } from '../rules-language/types.ts';
import { stProbeFor, resolveStProbe } from './rules-language-storage-capability.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const STORAGE_ACCEPTANCE_EVIDENCE_PATH = join(
  HERE,
  '..',
  'rules-language',
  'storage-acceptance-evidence.json',
);
export const STORAGE_ACCEPTANCE_EVIDENCE_NOTE =
  'Committed production acceptance evidence for Storage Security Rules captured over Google Cloud Rules Test API.';

export interface StorageAcceptanceEvidenceConstruct {
  id: string;
  kind: string;
  status: LanguageConstruct['status'];
  probeNote?: string;
  probeDigest?: { algorithm: 'sha256'; value: string };
  evaluationAgreement?: boolean;
  evaluationDetail?: string;
  expectedDecision?: 'ALLOW' | 'DENY';
  actualDecision?: 'ALLOW' | 'DENY';
  evidenceSource?: 'rules-test-api' | 'live-database';
}

export interface StorageAcceptanceEvidence {
  schema: 'pyric.conformance.storage-rules-acceptance-evidence.v1';
  generatedNote: string;
  capturedAt: string;
  projectId: string;
  engine: 'storage';
  total: number;
  accepted: number;
  rejected: number;
  unprobeable: number;
  evaluationAgree: number;
  evaluationDisagree: number;
  constructs: StorageAcceptanceEvidenceConstruct[];
}

interface CanonicalProbeFact {
  expectedDecision?: 'ALLOW' | 'DENY';
  unprobeableReason?: string;
}

const EXPECTS_DENY = new Set(['storage.semantic.deny-by-default']);

export function validateStorageAcceptanceEvidence(
  snapshot: readonly LanguageConstruct[],
  evidence: StorageAcceptanceEvidence,
  canonicalProbe: (construct: LanguageConstruct) => CanonicalProbeFact,
): void {
  if (
    evidence.schema !== 'pyric.conformance.storage-rules-acceptance-evidence.v1' ||
    evidence.generatedNote !== STORAGE_ACCEPTANCE_EVIDENCE_NOTE ||
    evidence.engine !== 'storage' ||
    !evidence.projectId ||
    Number.isNaN(Date.parse(evidence.capturedAt))
  ) {
    throw new Error('Storage acceptance evidence metadata is invalid');
  }
  if (evidence.total !== snapshot.length || evidence.constructs.length !== snapshot.length) {
    throw new Error(
      `Storage acceptance evidence universe mismatch: expected ${snapshot.length}, got ` +
        `${evidence.total}/${evidence.constructs.length}`,
    );
  }
  const byId = new Map<string, StorageAcceptanceEvidenceConstruct>();
  for (const row of evidence.constructs) {
    if (byId.has(row.id)) throw new Error(`Storage acceptance evidence duplicates ${row.id}`);
    byId.set(row.id, row);
  }
  for (const construct of snapshot) {
    const row = byId.get(construct.id);
    if (!row) throw new Error(`Storage acceptance evidence is missing ${construct.id}`);
    if (row.kind !== construct.kind || row.status !== construct.status) {
      throw new Error(`Storage acceptance evidence status/kind mismatch for ${construct.id}`);
    }
    if (JSON.stringify(row.probeDigest) !== JSON.stringify(construct.probeDigest)) {
      throw new Error(`Storage acceptance evidence probe digest mismatch for ${construct.id}`);
    }
    if (row.evaluationAgreement !== construct.probeEvaluationAgreement) {
      throw new Error(`Storage acceptance evidence agreement mismatch for ${construct.id}`);
    }
    if (row.probeNote !== construct.probeNote) {
      throw new Error(`Storage acceptance evidence probe note mismatch for ${construct.id}`);
    }
    const canonical = canonicalProbe(construct);
    if (row.status === 'unprobeable' && row.probeNote !== canonical.unprobeableReason) {
      throw new Error(`Storage acceptance evidence unprobeable reason mismatch for ${construct.id}`);
    }
    if (row.status === 'accepted') {
      if (
        !row.probeDigest ||
        row.expectedDecision === undefined ||
        row.actualDecision === undefined ||
        row.evaluationAgreement !== (row.expectedDecision === row.actualDecision) ||
        row.expectedDecision !== canonical.expectedDecision
      ) {
        throw new Error(`Storage acceptance evidence decisions are invalid for ${construct.id}`);
      }
    }
  }
}

export function loadAndValidateStorageAcceptanceEvidence(
  snapshot: readonly LanguageConstruct[],
): StorageAcceptanceEvidence {
  const evidence = JSON.parse(
    readFileSync(STORAGE_ACCEPTANCE_EVIDENCE_PATH, 'utf8'),
  ) as StorageAcceptanceEvidence;
  validateStorageAcceptanceEvidence(snapshot, evidence, (construct) => {
    const probe = resolveStProbe(stProbeFor(construct));
    if ('unprobeable' in probe) return { unprobeableReason: probe.unprobeable };
    return { expectedDecision: EXPECTS_DENY.has(construct.id) ? 'DENY' : 'ALLOW' };
  });
  return evidence;
}
