import { describe, expect, it } from 'bun:test';
import type { LanguageConstruct } from '../rules-language/types.ts';
import {
  type FirestoreAcceptanceEvidence,
  validateFirestoreAcceptanceEvidence,
} from './firestore-rules-acceptance-evidence.ts';

const construct: LanguageConstruct = {
  id: 'firestore.test', kind: 'function', engine: 'firestore', reference: 'test', status: 'accepted',
  probeDigest: { algorithm: 'sha256', value: 'a'.repeat(64) }, probeEvaluationAgreement: true,
};

function evidence(): FirestoreAcceptanceEvidence {
  return {
    schema: 'pyric.conformance.firestore-rules-acceptance-evidence.v1',
    capturedAt: '2026-07-21T00:00:00.000Z', projectId: 'test', engine: 'firestore', total: 1,
    constructs: [{
      id: construct.id, kind: construct.kind, status: 'accepted', probeDigest: construct.probeDigest,
      evaluationAgreement: true, expectedDecision: 'ALLOW', actualDecision: 'ALLOW',
    }],
  };
}

describe('Firestore acceptance evidence', () => {
  it('accepts exact snapshot, digest, and verdict agreement', () => {
    expect(() => validateFirestoreAcceptanceEvidence([construct], evidence())).not.toThrow();
  });

  it('rejects a boolean that contradicts the raw decisions', () => {
    const bad = evidence();
    bad.constructs[0]!.actualDecision = 'DENY';
    expect(() => validateFirestoreAcceptanceEvidence([construct], bad)).toThrow('decisions are invalid');
  });

  it('rejects stale probe evidence', () => {
    const bad = evidence();
    bad.constructs[0]!.probeDigest = { algorithm: 'sha256', value: 'b'.repeat(64) };
    expect(() => validateFirestoreAcceptanceEvidence([construct], bad)).toThrow('probe digest mismatch');
  });
});
