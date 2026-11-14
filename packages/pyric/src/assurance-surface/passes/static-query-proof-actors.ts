/**
 * Residual actor alignment and unified UID/claim proof search for
 * {@link staticQueryProofPass}.
 */
import type { FirestoreRules, MatchBlock, SimulateFirestoreRulesHandler } from '@pyric/rules/internal';
import {
  attachOrBudgetStep,
  getListBlockSteps,
  getOrBudgetSteps,
  isQueryProofScalar,
  proveListQuery,
  replaceTokenInQueryScalar,
  setListBlockSteps,
  topLevelMatches,
  type QueryConstraints,
  type QueryWhereConstraint,
  type RulesScalar,
} from '@pyric/rules/internal';
import {
  SYNTH_UID,
  type ConcretizedQueryTarget,
  type ProjectedQueryArm,
  type ScalarValue,
} from './static-query-proof-args.js';
import { collectClaimCandidateScalars } from './static-query-proof-scalars.js';

const MAX_UNIFIED_ACTORS = 12;

export interface ResidualSimOutcome {
  readonly allowed: boolean;
  readonly hitResourceLimit: boolean;
}

export type ResidualSimulatorFn = (
  simulator: SimulateFirestoreRulesHandler,
  evaluationAst: FirestoreRules,
  rulesSource: string,
  placeholderPath: string,
  auth: { uid: string; token?: Record<string, unknown> } | null,
  syntheticResource: Record<string, unknown>,
  constraints: QueryConstraints,
  getDoc?: (path: string) => Record<string, unknown> | null,
) => ResidualSimOutcome;

export function defineOwnField<V>(target: Record<string, V>, key: string, value: V): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function preserveBlockAndConditionBudgets(
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

    if (!dstSteps && srcSteps && srcSteps.some((step) => step.kind === 'budget')) {
      const mergedSteps: Array<NonNullable<typeof srcSteps>[number]> = [];
      let retainedGrantIdx = 0;
      for (const step of srcSteps) {
        if (step.kind === 'budget') {
          mergedSteps.push(step);
          continue;
        }
        const retainedRule = dstBlock.allows[retainedGrantIdx];
        if (retainedRule) {
          mergedSteps.push({ kind: 'grant', rule: retainedRule, index: step.index });
          retainedGrantIdx += 1;
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
  const rootCount = Math.min(srcRoots.length, dstRoots.length);
  for (let i = 0; i < rootCount; i += 1) {
    walkPair(srcRoots[i]!, dstRoots[i]!);
  }
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
      defineOwnField(next, key, toValue);
      changed = true;
    } else if (typeof toValue === 'string' && isQueryProofScalar(raw)) {
      const replaced = replaceTokenInQueryScalar(raw, fromToken, toValue);
      if (replaced !== raw) {
        defineOwnField(next, key, replaced);
        changed = true;
      } else {
        defineOwnField(next, key, raw);
      }
    } else {
      defineOwnField(next, key, raw);
    }
  }
  if (!changed) return syntheticResource;
  return next;
}

export function buildResidualCandidateAuths(
  target: ConcretizedQueryTarget,
  projected: ProjectedQueryArm,
): Array<{ uid: string; token?: Record<string, unknown> } | null> {
  const out: Array<{ uid: string; token?: Record<string, unknown> } | null> = [
    projected.auth,
    null,
  ];
  const seen = new Set<string>([projected.auth.uid]);
  for (const altUid of [...target.nonAuthSegmentValues, ...target.literalDocIdValues]) {
    if (!seen.has(altUid)) {
      seen.add(altUid);
      out.push({ uid: altUid, token: projected.auth.token });
    }
  }
  return out;
}

export function allowsResidualForAnyActor(
  simulateDecision: ResidualSimulatorFn,
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
    const out = simulateDecision(
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

export function tryUnifiedActorAndClaimProofs(
  simulateDecision: ResidualSimulatorFn,
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
        defineOwnField(unifiedToken, existingKey, projected.auth.token[existingKey]);
      }
      for (const [claimKey, claimScalar] of assignment) {
        defineOwnField(unifiedToken, claimKey, claimScalar);
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
          simulateDecision,
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
