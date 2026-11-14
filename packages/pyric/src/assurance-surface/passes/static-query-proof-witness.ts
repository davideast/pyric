/**
 * Optimistic parameter completion and unsupported-predicate witness synthesis
 * for {@link staticQueryProofPass}.
 */
import type { FirestoreRules, SimulateFirestoreRulesHandler } from '@pyric/rules/internal';
import {
  isQueryProofScalar,
  queryProofScalarsEqual,
  Reference,
  type QueryConstraints,
  type QueryProofFailure,
  type QueryWhereConstraint,
  type RulesScalar,
} from '@pyric/rules/internal';
import { fieldPathKeySegments } from '../../firestore/internal/update-fields.js';
import {
  SYNTH_UID,
  type ConcretizedQueryTarget,
  type ProjectedQueryArm,
  type UnresolvedWhereSlot,
} from './static-query-proof-args.js';
import {
  allowsResidualForAnyActor,
  defineOwnField,
  type ResidualSimulatorFn,
} from './static-query-proof-actors.js';
import { synthesizeFieldWitness } from './static-query-proof-domain-witness.js';
import { collectOptimisticFieldScalars } from './static-query-proof-scalars.js';

const MAX_OPTIMISTIC_COMBINATIONS = 24;

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

export function canSucceedWithOptimisticParams(
  checkArm: (constraints: QueryConstraints) => boolean,
  evaluationAst: FirestoreRules,
  placeholderPath: string,
  projected: ProjectedQueryArm,
  failures: readonly QueryProofFailure[],
  targetDatabaseId = '(default)',
): boolean {
  const provableSlots = projected.unresolvedWheres.filter((slot) => !slot.field.includes('`'));
  if (provableSlots.length === 0) return false;
  let combinations: QueryWhereConstraint[][] = [[]];

  for (const slot of provableSlots) {
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
    for (const astScalar of collectOptimisticFieldScalars(
      evaluationAst,
      placeholderPath,
      slot.field,
      targetDatabaseId,
    )) {
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
    if (checkArm(optimisticConstraints)) return true;
  }
  return false;
}

function setNestedResourceField(
  root: Record<string, unknown>,
  fieldPath: string,
  value: unknown,
): void {
  const parts = fieldPathKeySegments(fieldPath).filter((p) => p.length > 0);
  if (parts.length === 0) return;
  let cursor = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const seg = parts[i]!;
    let existing: unknown;
    if (Object.hasOwn(cursor, seg)) {
      existing = cursor[seg];
    }
    if (existing !== undefined && existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
      cursor = existing as Record<string, unknown>;
    } else {
      const next: Record<string, unknown> = {};
      defineOwnField(cursor, seg, next);
      cursor = next;
    }
  }
  defineOwnField(cursor, parts[parts.length - 1]!, value);
}

function extractCandidateDocLeaf(
  rawVal: unknown,
  collectionPath: string,
  targetDatabaseId: string,
): string | null {
  if (typeof rawVal === 'string') {
    if (rawVal.length === 0 || rawVal.includes('/')) return null;
    return rawVal;
  }
  if (rawVal instanceof Reference) {
    if (rawVal.databaseId !== targetDatabaseId) return null;
    if (rawVal.parent !== collectionPath || rawVal.id.length === 0) return null;
    return rawVal.id;
  }
  return null;
}

function projectDocIdConstraintToLeaf(
  clause: QueryWhereConstraint,
  collectionPath: string,
  targetDatabaseId: string,
): QueryWhereConstraint | null {
  if (Array.isArray(clause.value)) {
    const mapped: string[] = [];
    for (const item of clause.value) {
      if (item === null && clause.op === 'not-in') return null;
      const leaf = extractCandidateDocLeaf(item, collectionPath, targetDatabaseId);
      if (leaf !== null) {
        mapped.push(leaf);
      } else if (clause.op === 'in') {
        continue;
      }
    }
    if (clause.op === 'in' && mapped.length === 0) return null;
    return { field: '__id__', op: clause.op, value: mapped };
  }
  const leaf = extractCandidateDocLeaf(clause.value, collectionPath, targetDatabaseId);
  if (leaf === null) {
    if (clause.op === '!=') return { field: '__id__', op: '!=', value: '' };
    return null;
  }
  return { field: '__id__', op: clause.op, value: leaf };
}

function resolveDocIdCandidatePaths(
  placeholderPath: string,
  target: ConcretizedQueryTarget,
  projected: ProjectedQueryArm,
  targetDatabaseId: string,
): readonly string[] | null {
  if (target.isCollectionGroup) {
    return [placeholderPath];
  }
  if (projected.docIdWheres.length === 0 && projected.unresolvedDocIdWheres.length === 0) {
    return [placeholderPath];
  }

  const leafClauses: QueryWhereConstraint[] = [{ field: '__id__', op: '!=', value: '' }];
  for (const clause of projected.docIdWheres) {
    const mapped = projectDocIdConstraintToLeaf(clause, target.collectionPath, targetDatabaseId);
    if (mapped === null) return null;
    leafClauses.push(mapped);
  }
  for (const slot of projected.unresolvedDocIdWheres) {
    leafClauses.push(unresolvedSlotConstraint({ field: '__id__', op: slot.op }));
  }

  const inClause = leafClauses.find((c) => c.op === 'in' && Array.isArray(c.value));
  if (inClause && Array.isArray(inClause.value)) {
    const validPaths: string[] = [];
    for (const item of inClause.value) {
      if (typeof item !== 'string' || item.length === 0 || item.includes('/')) continue;
      const checkWitness = synthesizeFieldWitness([
        ...leafClauses,
        { field: '__id__', op: '==', value: item },
      ]);
      if (typeof checkWitness === 'string' && checkWitness.length > 0 && !checkWitness.includes('/')) {
        const full = `${target.collectionPath}/${checkWitness}`;
        if (!validPaths.includes(full)) validPaths.push(full);
      }
    }
    if (validPaths.length === 0) return null;
    return validPaths;
  }

  const synthesized = synthesizeFieldWitness(leafClauses);
  if (typeof synthesized !== 'string' || synthesized.length === 0 || synthesized.includes('/')) {
    return null;
  }
  return [`${target.collectionPath}/${synthesized}`];
}

function unresolvedSlotConstraint(slot: UnresolvedWhereSlot): QueryWhereConstraint {
  if (slot.op === 'in' || slot.op === 'not-in' || slot.op === 'array-contains-any') {
    return { field: slot.field, op: slot.op, value: [SYNTH_UID] };
  }
  return { field: slot.field, op: slot.op, value: SYNTH_UID };
}

export function canSucceedAgainstUnsupportedPredicate(
  simulateDecision: ResidualSimulatorFn,
  simulator: SimulateFirestoreRulesHandler,
  evaluationAst: FirestoreRules,
  rulesSource: string,
  placeholderPath: string,
  target: ConcretizedQueryTarget,
  projected: ProjectedQueryArm,
  failures: readonly QueryProofFailure[],
  targetDatabaseId = '(default)',
): boolean {
  if (
    !failures.some(
      (f) => f.kind === 'unsupported-predicate' || f.kind === 'unsupported-path',
    )
  ) {
    return false;
  }
  const hasAnyWhereEvidence =
    projected.witnessWheres.length > 0
    || projected.unresolvedWheres.length > 0
    || projected.docIdWheres.length > 0
    || projected.unresolvedDocIdWheres.length > 0;
  if (!hasAnyWhereEvidence) {
    return false;
  }
  const candidatePaths = resolveDocIdCandidatePaths(
    placeholderPath,
    target,
    projected,
    targetDatabaseId,
  );
  if (!candidatePaths || candidatePaths.length === 0) {
    return false;
  }

  const clausesByField = new Map<string, QueryWhereConstraint[]>();
  for (const w of projected.witnessWheres) {
    let list = clausesByField.get(w.field);
    if (!list) {
      list = [];
      clausesByField.set(w.field, list);
    }
    list.push(w);
  }
  for (const slot of projected.unresolvedWheres) {
    if (clausesByField.has(slot.field)) continue;
    clausesByField.set(slot.field, [unresolvedSlotConstraint(slot)]);
  }

  const candidateResource: Record<string, unknown> = {};
  for (const [fieldPath, clauses] of clausesByField) {
    const val = synthesizeFieldWitness(clauses);
    if (val === undefined) {
      return false;
    }
    setNestedResourceField(candidateResource, fieldPath, val);
  }

  return candidatePaths.every(
    (candPath) =>
      allowsResidualForAnyActor(
        simulateDecision,
        simulator,
        evaluationAst,
        rulesSource,
        candPath,
        target,
        projected,
        candidateResource,
        projected.constraints,
      ).allowed,
  );
}
