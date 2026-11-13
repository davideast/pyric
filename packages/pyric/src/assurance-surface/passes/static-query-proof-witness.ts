/**
 * Optimistic parameter completion and unsupported-predicate witness synthesis
 * for {@link staticQueryProofPass}.
 */
import type { FirestoreRules, SimulateFirestoreRulesHandler } from '@pyric/rules/internal';
import {
  Bytes,
  Duration,
  isQueryProofScalar,
  LatLng,
  Path,
  queryProofScalarsEqual,
  Reference,
  Timestamp,
  type QueryConstraints,
  type QueryProofFailure,
  type QueryWhereConstraint,
  type RulesScalar,
} from '@pyric/rules/internal';
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
    if (checkArm(optimisticConstraints)) return true;
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

function witnessValueForWhere(op: string, raw: QueryWhereConstraint['value']): unknown {
  if (op === '==') return raw;
  if (op === 'in') {
    if (Array.isArray(raw) && raw.length > 0) return raw[0];
    return raw;
  }
  if (op === 'array-contains') return [raw];
  if (op === 'array-contains-any') {
    if (Array.isArray(raw) && raw.length > 0) return [raw[0]];
    return [];
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
    if (raw instanceof LatLng) {
      let nextLat = 0;
      if (raw.lat === 0) nextLat = 1;
      return new LatLng(nextLat, raw.lng);
    }
    if (raw instanceof Duration) return new Duration(raw.seconds + 1, raw.nanos);
    return 'non-null';
  }
  return undefined;
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
    simulateDecision,
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
