import { SimulateFirestoreRulesHandler } from '../../pyric/src/rules/simulator/handler.ts';
import type { TestCase } from '../../pyric/src/rules/test/spec.ts';
import { firestoreRulesTestInputDigest } from './firestore-rules-input-digest.ts';
import type { Classification, ConstructCapability } from './rules-language-capability.ts';

export type ResolvedFirestoreProbe =
  | { rules: string; cases: TestCase[] }
  | { unprobeable: string };

type FirestoreCapabilityEvaluation = Pick<ConstructCapability,
  'classification' | 'detail' | 'probeDigest' | 'evaluationAgreement'>;

const simulator = new SimulateFirestoreRulesHandler();

function unsupportedReason(result: { trace: Array<{ verdict: string; message?: string }> }): string {
  return result.trace.find(({ verdict }) => verdict === 'UNSUPPORTED')?.message
    ?? 'evaluator abstained (UNSUPPORTED)';
}

/** Evaluate and provenance-bind one canonical Firestore capability probe. */
export function evaluateFirestoreCapability(
  resolved: ResolvedFirestoreProbe,
): FirestoreCapabilityEvaluation {
  if ('unprobeable' in resolved) {
    return { classification: 'unprobeable', detail: resolved.unprobeable };
  }
  const probeDigest = firestoreRulesTestInputDigest(resolved.rules, resolved.cases);
  let simulation;
  try {
    simulation = simulator.simulate(resolved.rules, resolved.cases);
  } catch (error) {
    return { classification: 'error', detail: `threw: ${(error as Error).message}`, probeDigest };
  }
  if (!simulation.success) {
    return {
      classification: 'error',
      detail: `${simulation.error.code}: ${simulation.error.message}`,
      probeDigest,
    };
  }
  const result = simulation.data.results[0];
  if (!result) return { classification: 'error', detail: 'no result row', probeDigest };
  if (result.decision === 'UNSUPPORTED') {
    return { classification: 'unsupported', detail: unsupportedReason(result), probeDigest };
  }
  const evaluationError = result.trace.find(({ verdict }) => verdict === 'ERROR');
  if (evaluationError && result.decision !== 'ALLOW') {
    return {
      classification: 'error',
      detail: `eval error: ${evaluationError.message ?? ''}`,
      probeDigest,
    };
  }
  const evaluationAgreement = simulation.data.results.length === resolved.cases.length
    && simulation.data.results.every((entry, index) => entry.decision === resolved.cases[index]?.expectation);
  return {
    classification: 'implemented' satisfies Classification,
    detail: `decision ${result.decision}`,
    evaluationAgreement,
    probeDigest,
  };
}
