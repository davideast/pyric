/**
 * Per-arm Firestore list-query proof, residual simulation, and optimistic
 * runtime-parameter completion for {@link staticQueryProofPass}.
 */
import type { FirestoreRules } from '../../rules/grammar/FirestoreAST.js';
import type { SimulateFirestoreRulesHandler } from '../../rules/simulator/handler.js';
import {
  listQueryFromConstraints,
  proveListQuery,
  type QueryConstraints,
  type QueryProofFailure,
  type QueryWhereConstraint,
} from '../../rules/simulator/list-query-proof.js';
import type { TestCase } from '../../rules/test/spec.js';
import type { DiagnosticCertainty } from '../../sandbox/internal/assurance-diagnostic.js';
import type { SdkQueryConstraint } from '../code/usage-index.js';
import {
  projectConstraintArm,
  renderClientQueryRemediation,
  SYNTH_UID,
  type ClientRemediationInput,
  type ConcretizedQueryTarget,
  type ProjectedQueryArm,
  type ScalarValue,
  type UnresolvedWhereSlot,
} from './static-query-proof-args.js';
import {
  collectOptimisticFieldScalars,
  inspectRetainedRules,
  projectCollectionGroupAst,
} from './static-query-proof-rules.js';

const MAX_OPTIMISTIC_COMBINATIONS = 12;

export interface ResolvedDatabaseRules {
  readonly source: string;
  readonly file: string;
  readonly ast: FirestoreRules;
}

export interface ArmFailure {
  readonly kind: ClientRemediationInput['kind'];
  readonly certainty: DiagnosticCertainty;
  readonly reason: string;
  readonly remediation: string;
  readonly ruleLine?: number;
  readonly ruleExpression?: string;
  readonly witnessArm: QueryConstraints;
}

interface ProofCheckFailure {
  readonly failed: true;
  readonly kind: ClientRemediationInput['kind'];
  readonly reason: string;
  readonly failures: readonly QueryProofFailure[];
  readonly ruleLine?: number;
  readonly ruleExpression?: string;
  readonly usedRequestQuery: boolean;
  readonly hasUnseededFallbackRule: boolean;
}

type ProofCheckOutcome = ProofCheckFailure | { readonly failed: false };

function simulateResidualDecision(
  simulator: SimulateFirestoreRulesHandler,
  evaluationAst: FirestoreRules,
  rulesSource: string,
  placeholderPath: string,
  auth: { uid: string; token?: Record<string, unknown> } | null,
  syntheticResource: Record<string, unknown>,
  constraints: QueryConstraints,
): boolean {
  const query = listQueryFromConstraints(constraints);
  const testCase: TestCase = {
    description: 'static-query-proof-residual',
    method: 'list',
    path: placeholderPath,
    auth,
    resource: syntheticResource,
    expectation: 'ALLOW',
  };
  if (query !== undefined) testCase.query = query;
  const sim = simulator.simulateParsed(evaluationAst, rulesSource, [testCase], {
    skipQueryProof: true,
  });
  return sim.success && sim.data.results[0]?.decision === 'ALLOW';
}

function selectPrimaryFailure(failures: readonly QueryProofFailure[]): QueryProofFailure {
  const structural = failures.find((f) => f.kind !== 'constraints-not-satisfied');
  if (structural) return structural;
  return failures[0]!;
}

function buildUnprovableFailure(
  failures: readonly QueryProofFailure[],
  hasUnseededFallbackRule: boolean,
): ProofCheckFailure {
  const primary = selectPrimaryFailure(failures);
  const out: {
    failed: true;
    kind: ClientRemediationInput['kind'];
    reason: string;
    failures: readonly QueryProofFailure[];
    ruleLine?: number;
    ruleExpression?: string;
    usedRequestQuery: false;
    hasUnseededFallbackRule: boolean;
  } = {
    failed: true,
    kind: primary.kind,
    reason: primary.reason,
    failures,
    usedRequestQuery: false,
    hasUnseededFallbackRule,
  };
  if (primary.rule?.line !== undefined) out.ruleLine = primary.rule.line;
  if (primary.rule?.expression !== undefined) out.ruleExpression = primary.rule.expression;
  return out;
}

function allowsResidualForAnyActor(
  simulator: SimulateFirestoreRulesHandler,
  evaluationAst: FirestoreRules,
  rulesSource: string,
  placeholderPath: string,
  target: ConcretizedQueryTarget,
  projected: ProjectedQueryArm,
  syntheticResource: Record<string, unknown>,
  constraints: QueryConstraints,
): boolean {
  if (
    simulateResidualDecision(
      simulator,
      evaluationAst,
      rulesSource,
      placeholderPath,
      projected.auth,
      syntheticResource,
      constraints,
    )
  ) {
    return true;
  }
  if (
    simulateResidualDecision(
      simulator,
      evaluationAst,
      rulesSource,
      placeholderPath,
      null,
      syntheticResource,
      constraints,
    )
  ) {
    return true;
  }
  if (!projected.usesSynthUidInWhere) {
    const altUids = [...target.nonAuthSegmentValues, ...target.literalDocIdValues];
    for (const altUid of altUids) {
      if (
        simulateResidualDecision(
          simulator,
          evaluationAst,
          rulesSource,
          placeholderPath,
          { uid: altUid, token: projected.auth.token },
          syntheticResource,
          constraints,
        )
      ) {
        return true;
      }
    }
    return false;
  }
  if (target.nonAuthSegmentValues.length > 0) {
    let alignedPath = placeholderPath;
    for (const segToken of target.nonAuthSegmentValues) {
      alignedPath = alignedPath.split(segToken).join(SYNTH_UID);
    }
    if (
      simulateResidualDecision(
        simulator,
        evaluationAst,
        rulesSource,
        alignedPath,
        projected.auth,
        syntheticResource,
        constraints,
      )
    ) {
      return true;
    }
  }
  return false;
}

function checkProofAndResidual(
  simulator: SimulateFirestoreRulesHandler,
  evaluationAst: FirestoreRules,
  rulesSource: string,
  placeholderPath: string,
  target: ConcretizedQueryTarget,
  projected: ProjectedQueryArm,
  constraints: QueryConstraints,
): ProofCheckOutcome {
  const proof = proveListQuery(
    evaluationAst,
    placeholderPath,
    projected.auth,
    constraints,
    rulesSource,
  );

  if (proof.kind === 'no-rule') {
    return {
      failed: true,
      kind: 'no-rule',
      reason: `no allow list or allow read rule matches '/${target.renderedPattern}/{docId}'`,
      failures: [],
      usedRequestQuery: false,
      hasUnseededFallbackRule: false,
    };
  }
  if (proof.kind === 'unprovable') {
    return buildUnprovableFailure(proof.failures, false);
  }
  if (
    allowsResidualForAnyActor(
      simulator,
      proof.evaluationAst,
      rulesSource,
      placeholderPath,
      target,
      projected,
      proof.syntheticResource,
      constraints,
    )
  ) {
    return { failed: false };
  }

  const populatedClaims = new Set(Object.keys(projected.auth.token));
  const retained = inspectRetainedRules(proof.evaluationAst, placeholderPath, populatedClaims);
  if (retained.usesUnseededContext && proof.failures.length === 0) {
    return { failed: false };
  }
  if (proof.failures.length > 0) {
    return buildUnprovableFailure(proof.failures, retained.usesUnseededContext);
  }

  let kind: ClientRemediationInput['kind'] = 'always-denied';
  let reason = `matching allow list rules unconditionally deny '/${target.renderedPattern}/{docId}'`;
  if (retained.usesRequestQuery) {
    kind = 'query-clause-denied';
    reason = `query does not satisfy the list rule's request.query constraint`;
  }
  const out: {
    failed: true;
    kind: ClientRemediationInput['kind'];
    reason: string;
    failures: readonly QueryProofFailure[];
    ruleLine?: number;
    ruleExpression?: string;
    usedRequestQuery: boolean;
    hasUnseededFallbackRule: false;
  } = {
    failed: true,
    kind,
    reason,
    failures: [],
    usedRequestQuery: retained.usesRequestQuery,
    hasUnseededFallbackRule: false,
  };
  if (retained.primaryRule?.line !== undefined) out.ruleLine = retained.primaryRule.line;
  if (retained.primaryRule?.expression !== undefined) {
    out.ruleExpression = retained.primaryRule.expression;
  }
  return out;
}

function slotToWhereConstraint(
  slot: UnresolvedWhereSlot,
  value: ScalarValue,
): QueryWhereConstraint | null {
  if (slot.op === '==' || slot.op === 'array-contains') {
    return { field: slot.field, op: slot.op, value };
  }
  if (slot.op === 'in' || slot.op === 'array-contains-any') {
    return { field: slot.field, op: slot.op, value: [value] };
  }
  return null;
}

function canSucceedWithOptimisticParams(
  simulator: SimulateFirestoreRulesHandler,
  evaluationAst: FirestoreRules,
  rulesSource: string,
  placeholderPath: string,
  target: ConcretizedQueryTarget,
  projected: ProjectedQueryArm,
  failures: readonly QueryProofFailure[],
): boolean {
  if (projected.unresolvedWheres.length === 0) return false;
  let combinations: QueryWhereConstraint[][] = [[]];

  for (const slot of projected.unresolvedWheres) {
    const candidates: ScalarValue[] = [];
    const pushCandidate = (v: unknown): void => {
      if (
        v === null
        || typeof v === 'string'
        || typeof v === 'boolean'
        || (typeof v === 'number' && Number.isFinite(v))
      ) {
        if (!candidates.some((existing) => Object.is(existing, v))) {
          candidates.push(v);
        }
      }
    };
    for (const f of failures) {
      for (const m of f.residual.missing) {
        if (m.field === slot.field) pushCandidate(m.expectedValue);
      }
      for (const m of f.residual.mismatched) {
        if (m.field === slot.field) pushCandidate(m.expectedValue);
      }
    }
    for (const astScalar of collectOptimisticFieldScalars(evaluationAst, placeholderPath, slot.field)) {
      pushCandidate(astScalar);
    }

    const mappedChoices: QueryWhereConstraint[] = [];
    for (const cand of candidates) {
      const built = slotToWhereConstraint(slot, cand);
      if (built) mappedChoices.push(built);
    }
    if (mappedChoices.length === 0) continue;

    const next: QueryWhereConstraint[][] = [];
    for (const prefix of combinations) {
      for (const choice of mappedChoices) {
        if (next.length >= MAX_OPTIMISTIC_COMBINATIONS) break;
        next.push([...prefix, choice]);
      }
      if (next.length >= MAX_OPTIMISTIC_COMBINATIONS) break;
    }
    combinations = next;
  }

  for (const extraWheres of combinations) {
    if (extraWheres.length === 0) continue;
    const optimisticConstraints: QueryConstraints = {
      ...projected.constraints,
      where: [...(projected.constraints.where ?? []), ...extraWheres],
    };
    const outcome = checkProofAndResidual(
      simulator,
      evaluationAst,
      rulesSource,
      placeholderPath,
      target,
      projected,
      optimisticConstraints,
    );
    if (!outcome.failed) return true;
  }
  return false;
}

export function evaluateCandidateArm(
  simulator: SimulateFirestoreRulesHandler,
  dbRules: ResolvedDatabaseRules,
  target: ConcretizedQueryTarget,
  arm: readonly SdkQueryConstraint[],
): ArmFailure | null {
  const projected = projectConstraintArm(arm);
  let evaluationAst: FirestoreRules | null = dbRules.ast;
  if (target.isCollectionGroup) {
    evaluationAst = projectCollectionGroupAst(dbRules.ast, target.collectionPath);
    if (!evaluationAst) {
      let certainty: DiagnosticCertainty = 'static-proof';
      if (target.hasPartialPath) certainty = 'heuristic';
      return {
        kind: 'no-group-rule',
        certainty,
        reason: `no path-invariant list or read rule governs every '${target.renderedPattern}' collection group`,
        remediation: renderClientQueryRemediation({
          kind: 'no-group-rule',
          isCollectionGroup: true,
          renderedPattern: target.renderedPattern,
        }),
        witnessArm: projected.constraints,
      };
    }
  }

  const placeholderPath = `${target.collectionPath}/__listPlaceholder__`;
  const check = checkProofAndResidual(
    simulator,
    evaluationAst,
    dbRules.source,
    placeholderPath,
    target,
    projected,
    projected.constraints,
  );
  if (!check.failed) return null;

  let certainty: DiagnosticCertainty = 'static-proof';
  if (target.hasPartialPath || projected.hasUnknownConstraint || check.hasUnseededFallbackRule) {
    certainty = 'heuristic';
  } else if (check.usedRequestQuery && projected.hasDynamicLimit) {
    certainty = 'heuristic';
  } else if (
    canSucceedWithOptimisticParams(
      simulator,
      evaluationAst,
      dbRules.source,
      placeholderPath,
      target,
      projected,
      check.failures,
    )
  ) {
    certainty = 'heuristic';
  }

  const primary = check.failures[0];
  const remInput: {
    kind: ClientRemediationInput['kind'];
    isCollectionGroup: boolean;
    renderedPattern: string;
    residual?: QueryProofFailure['residual'];
    ruleExpression?: string;
  } = {
    kind: check.kind,
    isCollectionGroup: target.isCollectionGroup,
    renderedPattern: target.renderedPattern,
  };
  if (primary?.residual !== undefined) remInput.residual = primary.residual;
  if (check.ruleExpression !== undefined) remInput.ruleExpression = check.ruleExpression;

  const failure: {
    kind: ClientRemediationInput['kind'];
    certainty: DiagnosticCertainty;
    reason: string;
    remediation: string;
    ruleLine?: number;
    ruleExpression?: string;
    witnessArm: QueryConstraints;
  } = {
    kind: check.kind,
    certainty,
    reason: check.reason.split('\u2014').join('--'),
    remediation: renderClientQueryRemediation(remInput),
    witnessArm: projected.constraints,
  };
  if (check.ruleLine !== undefined) failure.ruleLine = check.ruleLine;
  if (check.ruleExpression !== undefined) failure.ruleExpression = check.ruleExpression;
  return failure;
}
