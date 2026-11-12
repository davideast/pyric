/**
 * Per-arm Firestore list-query proof, residual simulation, and optimistic
 * runtime-parameter completion for {@link staticQueryProofPass}.
 */
import type { FirestoreRules, ListBlockStep, MatchBlock } from '@pyric/rules/internal';
import type { SimulateFirestoreRulesHandler } from '@pyric/rules/internal';
import {
  attachOrBudgetStep,
  Bytes,
  Duration,
  getListBlockSteps,
  getOrBudgetSteps,
  isQueryProofScalar,
  LatLng,
  listQueryFromConstraints,
  Path,
  proveListQuery,
  queryProofScalarsEqual,
  Reference,
  replaceTokenInQueryScalar,
  setListBlockSteps,
  Timestamp,
  topLevelMatches,
  type QueryConstraints,
  type QueryProofFailure,
  type QueryWhereConstraint,
  type RulesScalar,
} from '@pyric/rules/internal';
import type { TestCase } from '@pyric/rules/internal';
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
  collectClaimCandidateScalars,
  collectOptimisticFieldScalars,
  inspectRetainedRules,
  projectCollectionGroupAst,
} from './static-query-proof-rules.js';

const MAX_OPTIMISTIC_COMBINATIONS = 24;
const MAX_UNIFIED_ACTORS = 12;

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

interface ResidualSimOutcome {
  readonly allowed: boolean;
  readonly hitResourceLimit: boolean;
}

function preserveBlockAndConditionBudgets(
  sourceAst: FirestoreRules,
  projectedAst: FirestoreRules,
): void {
  const walkPair = (srcBlock: MatchBlock, dstBlock: MatchBlock): void => {
    const srcSteps = getListBlockSteps(srcBlock);
    const dstSteps = getListBlockSteps(dstBlock);

    let dstAllowIdx = 0;
    for (const srcRule of srcBlock.allows) {
      const dstRule = dstBlock.allows[dstAllowIdx];
      if (!dstRule) break;
      if (dstRule.loc === srcRule.loc && dstRule.operations === srcRule.operations) {
        const priorOrSteps = getOrBudgetSteps(srcRule.condition);
        if (
          priorOrSteps
          && priorOrSteps.length > 0
          && dstRule.condition !== srcRule.condition
          && !getOrBudgetSteps(dstRule.condition)
        ) {
          let wrapped = dstRule.condition;
          for (let i = priorOrSteps.length - 1; i >= 0; i -= 1) {
            wrapped = attachOrBudgetStep(wrapped, priorOrSteps[i]!);
          }
          dstRule.condition = wrapped;
        }
        dstAllowIdx += 1;
      }
    }

    if (srcSteps && srcSteps.some((step) => step.kind === 'budget')) {
      const mergedSteps: ListBlockStep[] = [];
      let grantOrdinal = 0;
      let retainedGrantIdx = 0;
      for (const step of srcSteps) {
        if (step.kind === 'budget') {
          mergedSteps.push(step);
          continue;
        }
        const subStep = dstSteps?.[grantOrdinal];
        grantOrdinal += 1;
        if (subStep) {
          mergedSteps.push({ ...subStep, index: step.index });
          if (subStep.kind === 'grant') retainedGrantIdx += 1;
        } else {
          const retainedRule = dstBlock.allows[retainedGrantIdx];
          if (retainedRule) {
            mergedSteps.push({ kind: 'grant', rule: retainedRule, index: step.index });
            retainedGrantIdx += 1;
          }
        }
      }
      setListBlockSteps(dstBlock, mergedSteps);
    }

    const childCount = Math.min(srcBlock.children.length, dstBlock.children.length);
    for (let i = 0; i < childCount; i += 1) {
      walkPair(srcBlock.children[i]!, dstBlock.children[i]!);
    }
  };

  const srcRoots = topLevelMatches(sourceAst.service);
  const dstRoots = topLevelMatches(projectedAst.service);
  if (
    sourceAst.functions !== undefined
    && projectedAst.functions === undefined
    && srcRoots.length === dstRoots.length
  ) {
    // Keep enclosing functions untouched.
  }
  const rootCount = Math.min(srcRoots.length, dstRoots.length);
  for (let i = 0; i < rootCount; i += 1) {
    walkPair(srcRoots[i]!, dstRoots[i]!);
  }
}

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

function defineOwn<V>(target: Record<string, V>, key: string, value: V): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function replaceTokenInScalar(
  value: RulesScalar,
  fromToken: string,
  toValue: RulesScalar,
): RulesScalar {
  if (value === fromToken) return toValue;
  if (typeof toValue === 'string') {
    return replaceTokenInQueryScalar(value, fromToken, toValue);
  }
  return value;
}

function replaceTokenInConstraints(
  constraints: QueryConstraints,
  fromToken: string,
  toValue: RulesScalar,
): QueryConstraints {
  if (!constraints.where) return constraints;
  let changed = false;
  const mappedWhere: QueryWhereConstraint[] = constraints.where.map((w) => {
    if (Array.isArray(w.value)) {
      let arrChanged = false;
      const nextArr = w.value.map((item) => {
        const nextItem = replaceTokenInScalar(item, fromToken, toValue);
        if (nextItem !== item) arrChanged = true;
        return nextItem;
      });
      if (!arrChanged) return w;
      changed = true;
      return { ...w, value: nextArr };
    }
    const singleVal = w.value as RulesScalar;
    const nextSingle = replaceTokenInScalar(singleVal, fromToken, toValue);
    if (nextSingle !== singleVal) {
      changed = true;
      return { ...w, value: nextSingle };
    }
    return w;
  });
  if (!changed) return constraints;
  return { ...constraints, where: mappedWhere };
}

function replaceTokenInSyntheticResource(
  syntheticResource: Record<string, unknown>,
  fromToken: string,
  toValue: RulesScalar,
): Record<string, unknown> {
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(syntheticResource)) {
    if (!Object.hasOwn(syntheticResource, key)) continue;
    const raw = syntheticResource[key];
    if (raw === fromToken) {
      defineOwn(next, key, toValue);
      changed = true;
    } else if (typeof toValue === 'string' && isQueryProofScalar(raw)) {
      const replaced = replaceTokenInQueryScalar(raw, fromToken, toValue);
      if (replaced !== raw) {
        defineOwn(next, key, replaced);
        changed = true;
      } else {
        defineOwn(next, key, raw);
      }
    } else {
      defineOwn(next, key, raw);
    }
  }
  return changed ? next : syntheticResource;
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
  getDoc?: (path: string) => Record<string, unknown> | null,
): ResidualSimOutcome {
  let hitResourceLimit = false;
  const check = (
    path: string,
    auth: { uid: string; token?: Record<string, unknown> } | null,
    res: Record<string, unknown>,
    c: QueryConstraints,
  ): boolean => {
    const out = simulateResidualDecision(
      simulator,
      evaluationAst,
      rulesSource,
      path,
      auth,
      res,
      c,
      getDoc,
    );
    if (out.hitResourceLimit) hitResourceLimit = true;
    return out.allowed;
  };

  if (check(placeholderPath, projected.auth, syntheticResource, constraints)) {
    return { allowed: true, hitResourceLimit: false };
  }
  if (check(placeholderPath, null, syntheticResource, constraints)) {
    return { allowed: true, hitResourceLimit: false };
  }
  if (!projected.usesSynthUidInWhere) {
    const altUids = [...target.nonAuthSegmentValues, ...target.literalDocIdValues];
    for (const altUid of altUids) {
      if (
        check(
          placeholderPath,
          { uid: altUid, token: projected.auth.token },
          syntheticResource,
          constraints,
        )
      ) {
        return { allowed: true, hitResourceLimit: false };
      }
    }
    return { allowed: false, hitResourceLimit };
  }
  if (target.nonAuthSegmentValues.length > 0) {
    for (const segToken of target.nonAuthSegmentValues) {
      const singleAligned = placeholderPath.split(segToken).join(projected.auth.uid);
      if (check(singleAligned, projected.auth, syntheticResource, constraints)) {
        return { allowed: true, hitResourceLimit: false };
      }
    }
    if (target.nonAuthSegmentValues.length > 1) {
      let alignedPath = placeholderPath;
      for (const segToken of target.nonAuthSegmentValues) {
        alignedPath = alignedPath.split(segToken).join(projected.auth.uid);
      }
      if (check(alignedPath, projected.auth, syntheticResource, constraints)) {
        return { allowed: true, hitResourceLimit: false };
      }
    }
  }
  if (target.literalDocIdValues.length > 0) {
    for (const litDocId of target.literalDocIdValues) {
      const alignedPath = placeholderPath.split(projected.auth.uid).join(litDocId);
      const alignedResource = replaceTokenInSyntheticResource(
        syntheticResource,
        projected.auth.uid,
        litDocId,
      );
      const alignedConstraints = replaceTokenInConstraints(
        constraints,
        projected.auth.uid,
        litDocId,
      );
      if (
        check(
          alignedPath,
          { uid: litDocId, token: projected.auth.token },
          alignedResource,
          alignedConstraints,
        )
      ) {
        return { allowed: true, hitResourceLimit: false };
      }
    }
  }
  return { allowed: false, hitResourceLimit };
}

function tryUnifiedActorAndClaimProofs(
  simulator: SimulateFirestoreRulesHandler,
  evaluationAst: FirestoreRules,
  rulesSource: string,
  placeholderPath: string,
  target: ConcretizedQueryTarget,
  projected: ProjectedQueryArm,
  constraints: QueryConstraints,
): boolean {
  const uidCandidates: string[] = [projected.auth.uid];
  if (projected.usesSynthUidInWhere || placeholderPath.includes(SYNTH_UID)) {
    for (const litDocId of target.literalDocIdValues) {
      if (!uidCandidates.includes(litDocId)) uidCandidates.push(litDocId);
    }
    for (const segToken of target.nonAuthSegmentValues) {
      if (!uidCandidates.includes(segToken)) uidCandidates.push(segToken);
    }
  }

  let claimAssignments: Array<Array<readonly [string, ScalarValue]>> = [[]];
  for (const claimKey of Object.keys(projected.auth.token)) {
    if (!Object.hasOwn(projected.auth.token, claimKey)) continue;
    const rawVal = projected.auth.token[claimKey];
    const synthClaim = `__pyric_claim_${claimKey}__`;
    if (rawVal !== synthClaim) continue;
    const scalars = collectClaimCandidateScalars(evaluationAst, placeholderPath, claimKey);
    if (scalars.length === 0) continue;

    const next: Array<Array<readonly [string, ScalarValue]>> = [];
    for (const prefix of claimAssignments) {
      next.push(prefix);
      for (const scalar of scalars) {
        if (next.length >= MAX_UNIFIED_ACTORS) break;
        next.push([...prefix, [claimKey, scalar] as const]);
      }
      if (next.length >= MAX_UNIFIED_ACTORS) break;
    }
    claimAssignments = next;
  }

  let attempts = 0;
  for (const uidCand of uidCandidates) {
    for (const assignment of claimAssignments) {
      if (uidCand === projected.auth.uid && assignment.length === 0) continue;
      if (attempts >= MAX_UNIFIED_ACTORS) return false;
      attempts += 1;

      let unifiedPath = placeholderPath;
      let unifiedConstraints = constraints;
      if (uidCand !== projected.auth.uid) {
        unifiedPath = unifiedPath.split(SYNTH_UID).join(uidCand);
        unifiedConstraints = replaceTokenInConstraints(unifiedConstraints, SYNTH_UID, uidCand);
      }

      const unifiedToken: Record<string, unknown> = {};
      for (const existingKey of Object.keys(projected.auth.token)) {
        if (!Object.hasOwn(projected.auth.token, existingKey)) continue;
        defineOwn(unifiedToken, existingKey, projected.auth.token[existingKey]);
      }
      for (const [claimKey, claimScalar] of assignment) {
        defineOwn(unifiedToken, claimKey, claimScalar);
        unifiedConstraints = replaceTokenInConstraints(
          unifiedConstraints,
          `__pyric_claim_${claimKey}__`,
          claimScalar,
        );
      }

      const unifiedProjected: ProjectedQueryArm = {
        ...projected,
        auth: { uid: uidCand, token: unifiedToken },
      };
      const unifiedProof = proveListQuery(
        evaluationAst,
        unifiedPath,
        unifiedProjected.auth,
        unifiedConstraints,
        rulesSource,
      );
      if (unifiedProof.kind !== 'provable') continue;
      if (unifiedProof.evaluationAst !== evaluationAst) {
        preserveBlockAndConditionBudgets(evaluationAst, unifiedProof.evaluationAst);
      }
      if (
        allowsResidualForAnyActor(
          simulator,
          unifiedProof.evaluationAst,
          rulesSource,
          unifiedPath,
          target,
          unifiedProjected,
          unifiedProof.syntheticResource,
          unifiedConstraints,
        ).allowed
      ) {
        return true;
      }
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
    if (
      tryUnifiedActorAndClaimProofs(
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
  if (retained.usesUnseededContext && proof.failures.length === 0) {
    if (!residualOutcome.hitResourceLimit) {
      return { failed: false };
    }
    const seededDocsOutcome = allowsResidualForAnyActor(
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
  if (proof.failures.length > 0) {
    return buildUnprovableFailure(proof.failures, retained.usesUnseededContext);
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

function slotToWhereConstraint(
  slot: UnresolvedWhereSlot,
  value: RulesScalar,
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
    const candidates: RulesScalar[] = [];
    const pushCandidate = (v: unknown): void => {
      if (isQueryProofScalar(v)) {
        if (!candidates.some((existing) => queryProofScalarsEqual(existing, v))) {
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

function setNestedResourceField(
  root: Record<string, unknown>,
  fieldPath: string,
  value: unknown,
): void {
  const parts = fieldPath.split('.').filter((p) => p.length > 0);
  if (parts.length === 0) return;
  let cursor = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const seg = parts[i]!;
    const existing = Object.hasOwn(cursor, seg) ? cursor[seg] : undefined;
    if (existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
      cursor = existing as Record<string, unknown>;
    } else {
      const next: Record<string, unknown> = {};
      defineOwn(cursor, seg, next);
      cursor = next;
    }
  }
  defineOwn(cursor, parts[parts.length - 1]!, value);
}

function witnessValueForWhere(op: string, raw: QueryWhereConstraint['value']): unknown {
  if (op === '==') return raw;
  if (op === 'in') return Array.isArray(raw) && raw.length > 0 ? raw[0] : raw;
  if (op === 'array-contains') return [raw];
  if (op === 'array-contains-any') {
    return Array.isArray(raw) && raw.length > 0 ? [raw[0]] : [];
  }
  if (op === '>') {
    if (typeof raw === 'number') return raw + 1;
    if (raw instanceof Timestamp) return new Timestamp(raw.seconds + 1, raw.nanos);
    if (raw instanceof Duration) return new Duration(raw.seconds + 1, raw.nanos);
  }
  if (op === '>=' || op === '<=') {
    if (typeof raw === 'number' || isQueryProofScalar(raw)) return raw;
  }
  if (op === '<') {
    if (typeof raw === 'number') return raw - 1;
    if (raw instanceof Timestamp) return new Timestamp(raw.seconds - 1, raw.nanos);
    if (raw instanceof Duration) return new Duration(raw.seconds - 1, raw.nanos);
  }
  if (op === '!=') {
    if (typeof raw === 'number') return raw + 1;
    if (typeof raw === 'boolean') return !raw;
    if (typeof raw === 'string') return `${raw}_alt`;
    if (raw instanceof Reference) return new Reference(`${raw.path}_alt`, raw.databaseId);
    if (raw instanceof Path) {
      return new Path([...raw.segments.slice(0, -1), `${raw.segments.at(-1) ?? 'doc'}_alt`]);
    }
    if (raw instanceof Timestamp) return new Timestamp(raw.seconds + 1, raw.nanos);
    if (raw instanceof Bytes) return new Bytes(new Uint8Array([...raw.data, 1]));
    if (raw instanceof LatLng) return new LatLng(raw.lat === 0 ? 1 : 0, raw.lng);
    if (raw instanceof Duration) return new Duration(raw.seconds + 1, raw.nanos);
    return 'non-null';
  }
  return undefined;
}

function canSucceedAgainstUnsupportedPredicate(
  simulator: SimulateFirestoreRulesHandler,
  evaluationAst: FirestoreRules,
  rulesSource: string,
  placeholderPath: string,
  target: ConcretizedQueryTarget,
  projected: ProjectedQueryArm,
  failures: readonly QueryProofFailure[],
): boolean {
  if (
    !failures.some(
      (f) => f.kind === 'unsupported-predicate' || f.kind === 'unsupported-path',
    )
  ) {
    return false;
  }
  const wheres = projected.constraints.where ?? [];
  if (wheres.length === 0 && projected.unresolvedWheres.length === 0) {
    return false;
  }
  const candidateResource: Record<string, unknown> = {};
  for (const w of wheres) {
    const val = witnessValueForWhere(w.op, w.value);
    if (val !== undefined) {
      setNestedResourceField(candidateResource, w.field, val);
    }
  }
  for (const slot of projected.unresolvedWheres) {
    const val = witnessValueForWhere(slot.op, SYNTH_UID);
    if (val !== undefined) {
      setNestedResourceField(candidateResource, slot.field, val);
    }
  }
  return allowsResidualForAnyActor(
    simulator,
    evaluationAst,
    rulesSource,
    placeholderPath,
    target,
    projected,
    candidateResource,
    projected.constraints,
  ).allowed;
}

export function evaluateCandidateArm(
  simulator: SimulateFirestoreRulesHandler,
  dbRules: ResolvedDatabaseRules,
  target: ConcretizedQueryTarget,
  arm: readonly SdkQueryConstraint[],
): ArmFailure | null {
  const targetDbId = dbRules.resourceId ?? '(default)';
  const projected = projectConstraintArm(arm, targetDbId);
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

  if (targetDbId !== '(default)') {
    const unnormalizedProjected = projectConstraintArm(arm, '(default)');
    const unnormalizedCheck = checkProofAndResidual(
      simulator,
      evaluationAst,
      dbRules.source,
      placeholderPath,
      target,
      unnormalizedProjected,
      unnormalizedProjected.constraints,
    );
    if (!unnormalizedCheck.failed) return null;
  }

  let certainty: DiagnosticCertainty = 'static-proof';
  if (target.hasPartialPath || projected.hasUnknownConstraint || check.hasUnseededFallbackRule) {
    certainty = 'heuristic';
  } else if (check.usedRequestQuery && (projected.hasDynamicLimit || projected.hasDynamicOrderBy)) {
    certainty = 'heuristic';
  } else if (
    canSucceedAgainstUnsupportedPredicate(
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
    reason: check.reason.split(SYNTH_UID).join('<uid>').split('\u2014').join('--'),
    remediation: renderClientQueryRemediation(remInput),
    witnessArm: projected.constraints,
  };
  if (check.ruleLine !== undefined) failure.ruleLine = check.ruleLine;
  if (check.ruleExpression !== undefined) failure.ruleExpression = check.ruleExpression;
  return failure;
}
