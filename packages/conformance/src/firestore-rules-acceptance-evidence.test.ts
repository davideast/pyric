import { describe, expect, it } from 'bun:test';
import type { LanguageConstruct } from '../rules-language/types.ts';
import {
  type FirestoreAcceptanceEvidence,
  FIRESTORE_ACCEPTANCE_EVIDENCE_NOTE,
  validateFirestoreAcceptanceEvidence,
} from './firestore-rules-acceptance-evidence.ts';

const construct: LanguageConstruct = {
  id: 'firestore.test', kind: 'function', engine: 'firestore', reference: 'test', status: 'accepted',
  probeDigest: { algorithm: 'sha256', value: 'a'.repeat(64) }, probeEvaluationAgreement: true,
};

function evidence(): FirestoreAcceptanceEvidence {
  return {
    schema: 'pyric.conformance.firestore-rules-acceptance-evidence.v1',
    generatedNote: FIRESTORE_ACCEPTANCE_EVIDENCE_NOTE,
    capturedAt: '2026-07-21T00:00:00.000Z', projectId: 'test', engine: 'firestore', total: 1,
    accepted: 1, rejected: 0, unprobeable: 0, evaluationAgree: 1, evaluationDisagree: 0,
    constructs: [{
      id: construct.id, kind: construct.kind, status: 'accepted', probeDigest: construct.probeDigest,
      evaluationAgreement: true, evaluationDetail: 'expected ALLOW, got ALLOW',
      expectedDecision: 'ALLOW', actualDecision: 'ALLOW',
    }],
  };
}

describe('Firestore acceptance evidence', () => {
  it('accepts exact snapshot, digest, and verdict agreement', () => {
    expect(() => validateFirestoreAcceptanceEvidence(
      [construct], evidence(), () => ({ expectedDecision: 'ALLOW' }),
    )).not.toThrow();
  });

  it('rejects a boolean that contradicts the raw decisions', () => {
    const bad = evidence();
    bad.constructs[0]!.actualDecision = 'DENY';
    expect(() => validateFirestoreAcceptanceEvidence(
      [construct], bad, () => ({ expectedDecision: 'ALLOW' }),
    )).toThrow('decisions are invalid');
  });

  it('rejects stale aggregate counts', () => {
    const bad = evidence();
    bad.accepted = 0;
    expect(() => validateFirestoreAcceptanceEvidence(
      [construct], bad, () => ({ expectedDecision: 'ALLOW' }),
    )).toThrow('aggregate counts');
  });

  it('rejects stale probe evidence', () => {
    const bad = evidence();
    bad.constructs[0]!.probeDigest = { algorithm: 'sha256', value: 'b'.repeat(64) };
    expect(() => validateFirestoreAcceptanceEvidence(
      [construct], bad, () => ({ expectedDecision: 'ALLOW' }),
    )).toThrow('probe digest mismatch');
  });

  it('rejects evidence captured against a stale canonical expectation', () => {
    expect(() => validateFirestoreAcceptanceEvidence(
      [construct], evidence(), () => ({ expectedDecision: 'DENY' }),
    )).toThrow('decisions are invalid');
  });

  it('rejects a snapshot rejection note that differs from production evidence', () => {
    const rejected: LanguageConstruct = {
      ...construct, status: 'rejected', probeEvaluationAgreement: undefined,
      probeNote: 'Function not found error: Name: [getAfter].',
    };
    const captured = evidence();
    Object.assign(captured, { accepted: 0, rejected: 1, evaluationAgree: 0, evaluationDisagree: 0 });
    captured.constructs[0] = {
      id: rejected.id, kind: rejected.kind, status: 'rejected', probeDigest: rejected.probeDigest,
      probeNote: 'Property getAfter is undefined on object.',
    };
    expect(() => validateFirestoreAcceptanceEvidence(
      [rejected], captured, () => ({ expectedDecision: 'ALLOW' }),
    )).toThrow('probe note mismatch');
  });

  it('requires raw verdict evidence for an evaluation-time rejection', () => {
    const rejected: LanguageConstruct = {
      ...construct, status: 'rejected', probeEvaluationAgreement: false,
      probeNote: 'Property id is undefined on object.',
    };
    const captured = evidence();
    Object.assign(captured, { accepted: 0, rejected: 1, evaluationAgree: 0, evaluationDisagree: 1 });
    captured.constructs[0] = {
      id: rejected.id, kind: rejected.kind, status: 'rejected', probeDigest: rejected.probeDigest,
      probeNote: rejected.probeNote, evaluationAgreement: false,
    };
    expect(() => validateFirestoreAcceptanceEvidence(
      [rejected], captured, () => ({ expectedDecision: 'ALLOW' }),
    )).toThrow('decisions are invalid');
  });
});
