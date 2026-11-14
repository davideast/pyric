/**
 * Per-arm Firestore list-query proof, residual simulation, and optimistic
 * runtime-parameter completion for {@link staticQueryProofPass}.
 */
import type { FirestoreRules, SimulateFirestoreRulesHandler, TestCase } from '@pyric/rules/internal';
import {
  listQueryFromConstraints,
  proveListQuery,
  type QueryConstraints,
  type QueryProofFailure,
} from '@pyric/rules/internal';
import type { DiagnosticCertainty } from '../../sandbox/internal/assurance-diagnostic.js';
import type { SdkQueryConstraint } from '../code/usage-index.js';
import {
  allowsResidualForAnyActor,
  preserveBlockAndConditionBudgets,
  tryUnifiedActorAndClaimProofs,
  type ResidualSimOutcome,
} from './static-query-proof-actors.js';
import {
  projectConstraintArm,
  renderClientQueryRemediation,
  SYNTH_UID,
  type ClientRemediationInput,
  type ConcretizedQueryTarget,
  type ProjectedQueryArm,
} from './static-query-proof-args.js';
import { inspectRetainedRules } from './static-query-proof-inspection.js';
import { canRetainedRulesPossiblyAllow } from './static-query-proof-possibility.js';
import { projectCollectionGroupAst } from './static-query-proof-rules.js';
import {
  canSucceedAgainstUnsupportedPredicate,
  canSucceedWithOptimisticParams,
} from './static-query-proof-witness.js';

export interface ResolvedDatabaseRules {
  readonly source: string;
  readonly file: string;
  readonly ast: FirestoreRules;
  readonly resourceId?: string;
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
  getDoc?: (path: string) => Record<string, unknown> | null,
): ResidualSimOutcome {
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
  const simOpts: {
    skipQueryProof: true;
    getDoc?: (path: string) => Record<string, unknown> | null;
  } = { skipQueryProof: true };
  if (getDoc !== undefined) simOpts.getDoc = getDoc;
  const sim = simulator.simulateParsed(evaluationAst, rulesSource, [testCase], simOpts);
  if (!sim.success) return { allowed: false, hitResourceLimit: false };
  const result = sim.data.results[0];
  return {
    allowed: result?.decision === 'ALLOW',
    hitResourceLimit: result?.resourceLimit !== undefined,
  };
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
    if (
      tryUnifiedActorAndClaimProofs(
        simulateResidualDecision,
        simulator,
        evaluationAst,
        rulesSource,
        placeholderPath,
        target,
        projected,
        constraints,
      )
    ) {
      return { failed: false };
    }
    return buildUnprovableFailure(proof.failures, false);
  }

  if (proof.evaluationAst !== evaluationAst) {
    preserveBlockAndConditionBudgets(evaluationAst, proof.evaluationAst);
  }

  const residualOutcome = allowsResidualForAnyActor(
    simulateResidualDecision,
    simulator,
    proof.evaluationAst,
    rulesSource,
    placeholderPath,
    target,
    projected,
    proof.syntheticResource,
    constraints,
  );
  if (residualOutcome.allowed) {
    return { failed: false };
  }
  if (
    tryUnifiedActorAndClaimProofs(
      simulateResidualDecision,
      simulator,
      evaluationAst,
      rulesSource,
      placeholderPath,
      target,
      projected,
      constraints,
    )
  ) {
    return { failed: false };
  }

  const populatedClaims = new Set(Object.keys(projected.auth.token));
  const retained = inspectRetainedRules(proof.evaluationAst, placeholderPath, populatedClaims);
  let hasUnseededFallbackRule = false;
  let unseededCanAllow = false;
  if (retained.usesUnseededContext) {
    unseededCanAllow = canRetainedRulesPossiblyAllow(
      simulateResidualDecision,
      simulator,
      proof.evaluationAst,
      rulesSource,
      placeholderPath,
      target,
      projected,
      proof.syntheticResource,
      constraints,
      populatedClaims,
    );
    if (proof.failures.length === 0) {
      if (!residualOutcome.hitResourceLimit) {
        if (unseededCanAllow) {
          return { failed: false };
        }
      } else {
        const seededDocsOutcome = allowsResidualForAnyActor(
          simulateResidualDecision,
          simulator,
          proof.evaluationAst,
          rulesSource,
          placeholderPath,
          target,
          projected,
          proof.syntheticResource,
          constraints,
          () => ({}),
        );
        if (seededDocsOutcome.allowed || !seededDocsOutcome.hitResourceLimit) {
          hasUnseededFallbackRule = true;
        }
      }
    }
  }
  if (proof.failures.length > 0) {
    return buildUnprovableFailure(proof.failures, unseededCanAllow);
  }

  let kind: ClientRemediationInput['kind'] = 'always-denied';
  let reason = `matching allow list rules unconditionally deny '/${target.renderedPattern}/{docId}'`;
  if (residualOutcome.hitResourceLimit) {
    reason = `matching allow list rules exceed per-request evaluation budget on '/${target.renderedPattern}/{docId}'`;
  } else if (retained.usesRequestQuery) {
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
    hasUnseededFallbackRule: boolean;
  } = {
    failed: true,
    kind,
    reason,
    failures: [],
    usedRequestQuery: retained.usesRequestQuery,
    hasUnseededFallbackRule,
  };
  if (retained.primaryRule?.line !== undefined) out.ruleLine = retained.primaryRule.line;
  if (retained.primaryRule?.expression !== undefined) {
    out.ruleExpression = retained.primaryRule.expression;
  }
  return out;
}

export function evaluateCandidateArm(
  simulator: SimulateFirestoreRulesHandler,
  dbRules: ResolvedDatabaseRules,
  target: ConcretizedQueryTarget,
  arm: readonly SdkQueryConstraint[],
): ArmFailure | null {
  const targetDbId = dbRules.resourceId ?? '(default)';
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
  } else if (check.usedRequestQuery && (projected.hasDynamicLimit || projected.hasDynamicOrderBy)) {
    certainty = 'heuristic';
  } else if (
    canSucceedAgainstUnsupportedPredicate(
      simulateResidualDecision,
      simulator,
      evaluationAst,
      dbRules.source,
      placeholderPath,
      target,
      projected,
      check.failures,
      targetDbId,
    )
  ) {
    certainty = 'heuristic';
  } else if (
    canSucceedWithOptimisticParams(
      (optimisticConstraints) =>
        !checkProofAndResidual(
          simulator,
          evaluationAst,
          dbRules.source,
          placeholderPath,
          target,
          projected,
          optimisticConstraints,
        ).failed,
      evaluationAst,
      placeholderPath,
      projected,
      check.failures,
      targetDbId,
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
    reason: check.reason.split(SYNTH_UID).join('<uid>').split('\u2014').join('--'),
    remediation: renderClientQueryRemediation(remInput),
    witnessArm: projected.constraints,
  };
  if (check.ruleLine !== undefined) failure.ruleLine = check.ruleLine;
  if (check.ruleExpression !== undefined) failure.ruleExpression = check.ruleExpression;
  return failure;
}
