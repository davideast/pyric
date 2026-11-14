/**
 * Query-target concretization, DNF constraint-arm expansion, auth/literal
 * operand projection, and copy-paste client remediation rendering for
 * {@link staticQueryProofPass}.
 */
import {
  Bytes,
  Duration,
  formatQueryScalarForRemediation,
  LatLng,
  Reference,
  Timestamp,
  type QueryConstraints,
  type QueryProofResidual,
  type QueryWhereConstraint,
  type RulesScalar,
} from '@pyric/rules/internal';
import { renderResourcePattern } from '../../sandbox/internal/resource-pattern.js';
import type {
  ConstraintOperand,
  SdkQuery,
  SdkQueryConstraint,
  SdkRef,
  WrapperOperandValue,
} from '../code/usage-index.js';

export const SYNTH_UID = '__pyric_synth_uid__';
const MAX_BRANCH_DNF_ARMS = 64;
const MAX_TOTAL_DNF_ARMS = 256;

export interface ExpandedQueryArms {
  readonly arms: SdkQueryConstraint[][];
  readonly truncated: boolean;
}

export type ScalarValue = string | number | boolean | null;
export type ProofScalarValue = RulesScalar;

export interface UnresolvedWhereSlot {
  readonly field: string;
  readonly op: string;
}

export interface ProjectedQueryArm {
  readonly constraints: QueryConstraints;
  readonly witnessWheres: readonly QueryWhereConstraint[];
  readonly docIdWheres: readonly QueryWhereConstraint[];
  readonly unresolvedDocIdWheres: readonly UnresolvedWhereSlot[];
  readonly auth: { readonly uid: string; readonly token: Record<string, unknown> };
  readonly unresolvedWheres: readonly UnresolvedWhereSlot[];
  readonly hasUnknownConstraint: boolean;
  readonly hasDynamicLimit: boolean;
  readonly hasDynamicOrderBy: boolean;
  readonly usesSynthUidInWhere: boolean;
}

export interface ConcretizedQueryTarget {
  readonly isCollectionGroup: boolean;
  readonly collectionPath: string;
  readonly renderedPattern: string;
  readonly hasDynamicSegment: boolean;
  readonly hasPartialPath: boolean;
  readonly nonAuthSegmentValues: readonly string[];
  readonly literalDocIdValues: readonly string[];
}

export interface ClientRemediationInput {
  readonly kind:
    | 'constraints-not-satisfied'
    | 'unsupported-predicate'
    | 'unsupported-path'
    | 'no-rule'
    | 'no-group-rule'
    | 'query-clause-denied'
    | 'always-denied';
  readonly isCollectionGroup: boolean;
  readonly renderedPattern: string;
  readonly residual?: QueryProofResidual;
  readonly ruleExpression?: string;
}

export function concretizeQueryTarget(baseRef: SdkRef): ConcretizedQueryTarget | null {
  if (baseRef.pattern.service !== 'firestore') return null;
  if (baseRef.refKind === 'doc') return null;
  if (baseRef.resolution === 'unresolved') return null;
  const segments = baseRef.pattern.segments;
  if (segments.length === 0) return null;

  const renderedPattern = renderResourcePattern(baseRef.pattern);
  if (baseRef.refKind === 'collectionGroup') {
    const leaf = segments[segments.length - 1];
    if (!leaf || leaf.kind === 'rest') return null;
    const hasUntracedGroupId = baseRef.reason?.includes('collection group id ') === true;
    if (leaf.kind === 'lit' && !hasUntracedGroupId) {
      return {
        isCollectionGroup: true,
        collectionPath: leaf.text,
        renderedPattern: leaf.text,
        hasDynamicSegment: false,
        hasPartialPath: baseRef.resolution !== 'resolved',
        nonAuthSegmentValues: [],
        literalDocIdValues: [],
      };
    }
    let groupLabel: string;
    if (leaf.kind === 'lit') {
      groupLabel = leaf.text;
    } else {
      groupLabel = leaf.name;
    }
    return {
      isCollectionGroup: true,
      collectionPath: `__pyric_group_${groupLabel}__`,
      renderedPattern,
      hasDynamicSegment: true,
      hasPartialPath: true,
      nonAuthSegmentValues: [],
      literalDocIdValues: [],
    };
  }

  if (segments.length % 2 === 0) return null;

  const concreteSegments: string[] = [];
  const nonAuthSegmentValues: string[] = [];
  const literalDocIdValues: string[] = [];
  let hasDynamicSegment = false;
  let hasPartialPath = baseRef.resolution !== 'resolved';
  let varIndex = 0;

  for (let idx = 0; idx < segments.length; idx++) {
    const seg = segments[idx]!;
    if (seg.kind === 'lit') {
      concreteSegments.push(seg.text);
      if (idx % 2 === 1) {
        literalDocIdValues.push(seg.text);
      }
      continue;
    }

    hasDynamicSegment = true;
    if (idx % 2 === 0) {
      hasPartialPath = true;
    }
    const pv = baseRef.pathVariables[varIndex];
    varIndex += 1;
    const hasAuthUid = pv?.auth?.some((a) => a.source === 'auth.uid') ?? false;
    if (hasAuthUid && pv?.pattern === undefined) {
      concreteSegments.push(SYNTH_UID);
    } else if (hasAuthUid && pv?.pattern !== undefined) {
      const built = pv.pattern
        .split('{auth.uid}')
        .join(SYNTH_UID)
        .split('{*}')
        .join(`__pyric_part_${idx}__`);
      concreteSegments.push(built);
      hasPartialPath = true;
    } else {
      const token = `__pyric_seg_${idx}_${seg.name}__`;
      concreteSegments.push(token);
      nonAuthSegmentValues.push(token);
    }
  }

  return {
    isCollectionGroup: false,
    collectionPath: concreteSegments.join('/'),
    renderedPattern,
    hasDynamicSegment,
    hasPartialPath,
    nonAuthSegmentValues,
    literalDocIdValues,
  };
}

function expandSingleConstraint(constraint: SdkQueryConstraint): ExpandedQueryArms {
  if (constraint.kind === 'and') {
    return expandConstraintSequence(constraint.children ?? []);
  }
  if (constraint.kind === 'or') {
    const children = constraint.children ?? [];
    if (children.length === 0) return { arms: [[]], truncated: false };
    const arms: SdkQueryConstraint[][] = [];
    let truncated = false;
    for (const child of children) {
      const expandedChild = expandSingleConstraint(child);
      if (expandedChild.truncated) truncated = true;
      for (const arm of expandedChild.arms) {
        if (arms.length >= MAX_BRANCH_DNF_ARMS) {
          truncated = true;
          break;
        }
        arms.push(arm);
      }
    }
    return { arms, truncated };
  }
  return { arms: [[constraint]], truncated: false };
}

function expandConstraintSequence(sequence: readonly SdkQueryConstraint[]): ExpandedQueryArms {
  let arms: SdkQueryConstraint[][] = [[]];
  let truncated = false;
  for (const item of sequence) {
    const choices = expandSingleConstraint(item);
    if (choices.truncated) truncated = true;
    const next: SdkQueryConstraint[][] = [];
    for (const prefix of arms) {
      for (const choice of choices.arms) {
        if (next.length >= MAX_BRANCH_DNF_ARMS) {
          truncated = true;
          break;
        }
        next.push([...prefix, ...choice]);
      }
      if (next.length >= MAX_BRANCH_DNF_ARMS && choices.arms.length > 0) {
        // Check whether additional prefixes remained unexpanded
        if (prefix !== arms[arms.length - 1]) {
          truncated = true;
        }
        break;
      }
    }
    arms = next;
  }
  return { arms, truncated };
}

function armSignature(arm: readonly SdkQueryConstraint[]): string {
  return JSON.stringify(arm);
}

export function expandQueryArmsWithTruncation(query: SdkQuery): ExpandedQueryArms {
  const branches = query.branches ?? [query.constraints];
  const expandedBranches = branches.map(expandConstraintSequence);
  let truncated = expandedBranches.some((b) => b.truncated);
  const seen = new Set<string>();
  const arms: SdkQueryConstraint[][] = [];

  const pushUniqueArm = (arm: SdkQueryConstraint[]): void => {
    const sig = armSignature(arm);
    if (seen.has(sig)) return;
    if (arms.length >= MAX_TOTAL_DNF_ARMS) {
      truncated = true;
      return;
    }
    seen.add(sig);
    arms.push(arm);
  };

  for (const expanded of expandedBranches) {
    const firstArm = expanded.arms[0];
    if (firstArm !== undefined) pushUniqueArm(firstArm);
  }
  for (const expanded of expandedBranches) {
    for (let i = 1; i < expanded.arms.length; i += 1) {
      pushUniqueArm(expanded.arms[i]!);
    }
  }
  return { arms, truncated };
}

export function expandQueryArms(query: SdkQuery): SdkQueryConstraint[][] {
  return expandQueryArmsWithTruncation(query).arms;
}

function defineOwn<V>(target: Record<string, V>, key: string, value: V): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function resolveAuthSources(
  sources: readonly string[],
  token: Record<string, unknown>,
): { resolved: true; value: string; usedSynthUid: boolean } | { resolved: false } {
  if (sources.includes('auth.uid')) {
    return { resolved: true, value: SYNTH_UID, usedSynthUid: true };
  }
  if (sources.includes('auth.email')) {
    token.email = 'synth@example.test';
    token.email_verified = true;
    return { resolved: true, value: 'synth@example.test', usedSynthUid: false };
  }
  if (sources.includes('auth.displayName')) {
    token.name = '__pyric_display_name__';
    return { resolved: true, value: '__pyric_display_name__', usedSynthUid: false };
  }
  if (sources.includes('auth.phoneNumber')) {
    token.phone_number = '+15555550100';
    return { resolved: true, value: '+15555550100', usedSynthUid: false };
  }
  if (sources.includes('auth.photoURL')) {
    token.picture = 'https://example.test/avatar.png';
    return { resolved: true, value: 'https://example.test/avatar.png', usedSynthUid: false };
  }
  const claimSource = sources.find((s) => s.startsWith('auth.token.'));
  if (claimSource !== undefined) {
    const claim = claimSource.slice('auth.token.'.length);
    const claimValue = `__pyric_claim_${claim}__`;
    defineOwn(token, claim, claimValue);
    return { resolved: true, value: claimValue, usedSynthUid: false };
  }
  return { resolved: false };
}

function resolveWrapperOperand(
  wrapper: WrapperOperandValue,
  token: Record<string, unknown>,
): { resolved: true; value: ProofScalarValue; usedSynthUid: boolean } | { resolved: false } {
  switch (wrapper.wrapperKind) {
    case 'reference': {
      const resolvedSegments: string[] = [];
      let usedSynthUid = false;
      for (const seg of wrapper.segments) {
        if (seg.kind === 'lit') {
          resolvedSegments.push(seg.text);
          continue;
        }
        if (seg.pattern !== undefined) {
          resolvedSegments.push(seg.pattern.split('{auth.uid}').join(SYNTH_UID));
          usedSynthUid = true;
          continue;
        }
        const resolvedSeg = resolveAuthSources(
          seg.auth.map((a) => a.source),
          token,
        );
        if (!resolvedSeg.resolved) return { resolved: false };
        if (resolvedSeg.usedSynthUid) usedSynthUid = true;
        resolvedSegments.push(resolvedSeg.value);
      }
      return {
        resolved: true,
        value: new Reference(resolvedSegments.join('/'), wrapper.databaseId),
        usedSynthUid,
      };
    }
    case 'timestamp':
      return {
        resolved: true,
        value: new Timestamp(wrapper.seconds, wrapper.nanoseconds),
        usedSynthUid: false,
      };
    case 'bytes':
      return {
        resolved: true,
        value: new Bytes(new Uint8Array(wrapper.bytes)),
        usedSynthUid: false,
      };
    case 'latlng':
      return {
        resolved: true,
        value: new LatLng(wrapper.latitude, wrapper.longitude),
        usedSynthUid: false,
      };
    case 'duration':
      return {
        resolved: true,
        value: new Duration(wrapper.seconds, wrapper.nanoseconds),
        usedSynthUid: false,
      };
  }
}

function resolveScalarOperand(
  operand: ConstraintOperand | undefined,
  token: Record<string, unknown>,
): { resolved: true; value: ProofScalarValue; usedSynthUid: boolean } | { resolved: false } {
  if (!operand) return { resolved: false };
  if (operand.kind === 'literal' && operand.literal !== undefined) {
    return { resolved: true, value: operand.literal, usedSynthUid: false };
  }
  if (operand.kind === 'wrapper' && operand.wrapper !== undefined) {
    return resolveWrapperOperand(operand.wrapper, token);
  }
  if (operand.kind !== 'auth') {
    return { resolved: false };
  }
  return resolveAuthSources(
    (operand.auth ?? []).map((a) => a.source),
    token,
  );
}

export function projectConstraintArm(
  arm: readonly SdkQueryConstraint[],
): ProjectedQueryArm {
  const token: Record<string, unknown> = {};
  const wheres: QueryWhereConstraint[] = [];
  const witnessWheres: QueryWhereConstraint[] = [];
  const docIdWheres: QueryWhereConstraint[] = [];
  const unresolvedDocIdWheres: UnresolvedWhereSlot[] = [];
  const unresolvedWheres: UnresolvedWhereSlot[] = [];
  let limit: number | undefined;
  const orderByMap: Record<string, 'ASC' | 'DESC'> = {};
  let hasOrderBy = false;
  let hasUnknownConstraint = false;
  let hasDynamicLimit = false;
  let hasDynamicOrderBy = false;
  let usesSynthUidInWhere = false;

  const pushResolvedWhere = (clause: QueryWhereConstraint): void => {
    if (clause.field === '__name__') {
      docIdWheres.push(clause);
      return;
    }
    witnessWheres.push(clause);
    if (!clause.field.includes('`')) {
      wheres.push(clause);
    }
  };

  const pushUnresolvedWhere = (slot: UnresolvedWhereSlot): void => {
    if (slot.field === '__name__') {
      unresolvedDocIdWheres.push(slot);
      return;
    }
    unresolvedWheres.push(slot);
  };

  for (const constraint of arm) {
    if (constraint.kind === 'unknown') {
      hasUnknownConstraint = true;
      continue;
    }
    if (constraint.kind === 'where') {
      if (constraint.field === undefined || constraint.op === undefined) {
        hasUnknownConstraint = true;
        continue;
      }
      if (constraint.operand?.kind === 'array') {
        const items = constraint.operand.items ?? [];
        const scalars: ProofScalarValue[] = [];
        let allResolved = items.length > 0;
        for (const item of items) {
          const resolved = resolveScalarOperand(item, token);
          if (!resolved.resolved) {
            allResolved = false;
            break;
          }
          if (resolved.usedSynthUid) usesSynthUidInWhere = true;
          scalars.push(resolved.value);
        }
        if (allResolved) {
          pushResolvedWhere({ field: constraint.field, op: constraint.op, value: scalars });
        } else {
          pushUnresolvedWhere({ field: constraint.field, op: constraint.op });
        }
        continue;
      }
      const scalar = resolveScalarOperand(constraint.operand, token);
      if (scalar.resolved) {
        if (scalar.usedSynthUid) usesSynthUidInWhere = true;
        pushResolvedWhere({ field: constraint.field, op: constraint.op, value: scalar.value });
      } else {
        pushUnresolvedWhere({ field: constraint.field, op: constraint.op });
      }
      continue;
    }
    if (constraint.kind === 'limit' || constraint.kind === 'limitToLast') {
      if (constraint.operand?.kind === 'literal' && typeof constraint.operand.literal === 'number') {
        limit = constraint.operand.literal;
      } else {
        hasDynamicLimit = true;
      }
      continue;
    }
    if (constraint.kind === 'orderBy') {
      if (constraint.field !== undefined) {
        const dir = constraint.direction === 'desc' ? 'DESC' : 'ASC';
        defineOwn(orderByMap, constraint.field, dir);
        hasOrderBy = true;
      } else {
        hasDynamicOrderBy = true;
      }
    }
  }

  const constraints: {
    where?: readonly QueryWhereConstraint[];
    limit?: number;
    orderBy?: Readonly<Record<string, 'ASC' | 'DESC'>>;
  } = {};
  if (wheres.length > 0) constraints.where = wheres;
  if (limit !== undefined) constraints.limit = limit;
  if (hasOrderBy) constraints.orderBy = orderByMap;

  return {
    constraints,
    witnessWheres,
    docIdWheres,
    unresolvedDocIdWheres,
    auth: { uid: SYNTH_UID, token },
    unresolvedWheres,
    hasUnknownConstraint,
    hasDynamicLimit,
    hasDynamicOrderBy,
    usesSynthUidInWhere,
  };
}

export function sanitizeDisplayValue(value: unknown): string {
  if (
    typeof value === 'string'
    && value.includes('__pyric_')
    && !value.includes(SYNTH_UID)
  ) {
    return 'a dynamic value';
  }
  return formatQueryScalarForRemediation(value, {
    uidExpression: 'currentUser.uid',
    dynamicExpression: 'a dynamic value',
  });
}

export function renderClientQueryRemediation(input: ClientRemediationInput): string {
  if (input.kind === 'no-group-rule') {
    return (
      `Add a path-invariant collection-group rule such as ` +
      `match /{path=**}/${input.renderedPattern}/{docId} { allow list: if ...; }.`
    );
  }
  if (input.kind === 'no-rule') {
    return (
      `Add an allow list (or allow read) rule covering /${input.renderedPattern}/{docId}, ` +
      `or remove the client list query.`
    );
  }
  if (input.kind === 'query-clause-denied') {
    let suffix = '';
    if (input.ruleExpression) {
      suffix = ` (${input.ruleExpression})`;
    }
    return `Add limit(...) or matching query clauses to query(...) to satisfy request.query${suffix}.`;
  }
  if (input.kind === 'always-denied') {
    return (
      `Update the allow list rule covering /${input.renderedPattern}/{docId}; ` +
      `matching list rules unconditionally deny.`
    );
  }

  const clauses: string[] = [];
  for (const m of input.residual?.missing ?? []) {
    let exprText = 'currentUser.uid';
    if (!m.fromAuthUid) {
      exprText = sanitizeDisplayValue(m.expectedValue);
    }
    clauses.push(`where('${m.field}', '==', ${exprText}) (or .where('${m.field}', '==', ${exprText}))`);
  }
  for (const m of input.residual?.mismatched ?? []) {
    const expectedText = sanitizeDisplayValue(m.expectedValue);
    const actualText = sanitizeDisplayValue(m.actualValue);
    clauses.push(
      `where('${m.field}', '==', ${expectedText}) (or .where('${m.field}', '==', ${expectedText}); currently ${actualText})`,
    );
  }
  if (clauses.length > 0) {
    return `Constrain query(...) with ${clauses.join(' and ')} so every returned document satisfies the list rule.`;
  }
  const predicateText = input.residual?.predicate ?? input.ruleExpression ?? '';
  const arrayMemberMatch = /\brequest\.auth\.uid\s+in\s+resource\.data\.([A-Za-z_][A-Za-z0-9_]*)\b/.exec(
    predicateText,
  );
  if (arrayMemberMatch !== null) {
    const memberField = arrayMemberMatch[1]!;
    return (
      `Constrain query(...) with where('${memberField}', 'array-contains', currentUser.uid) ` +
      `(or .where('${memberField}', 'array-contains', currentUser.uid)) so every returned document satisfies the list rule.`
    );
  }
  return (
    `Constrain query(...) with a where(...) / .where(...) filter matching a provable allow list rule ` +
    `covering /${input.renderedPattern}/{docId} ("rules are not filters").`
  );
}
