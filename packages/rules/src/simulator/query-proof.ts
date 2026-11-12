/**
 * RULES-B11 (rules-side) - query-proof evaluation for `list` operations.
 *
 * Production Firestore enforces "rules are NOT filters." For a query (`list`),
 * the engine does not run the rule per-document and silently drop the docs that
 * fail; it evaluates the rule once against the query itself, and rejects the
 * whole query unless the rules can prove that every document the query could
 * return is readable. A query the rules cannot prove safe is denied outright
 * (`permission-denied`), never silently truncated.
 *
 *   docs: https://firebase.google.com/docs/firestore/security/rules-query
 *
 * Scope of the proof here:
 *  - A `list` rule that does not depend on per-document data
 *    (`resource.data.*`) - only `request.auth`, `request.query`, constants,
 *    path variables - is doc-independent: if it evaluates allow, every doc is
 *    equally allowed, so any query shape is provable.
 *  - A rule that requires a per-document predicate (`resource.data.<field> ==
 *    <const>`, conjoined into the condition) is provable only if the query
 *    carries a `where(<field>, <op>, <const>)` constraint that guarantees the
 *    same predicate. Otherwise the query could return a non-matching doc, so
 *    prod rejects it and we return `provable: false`.
 *
 * Additional supported facts: scalar equality/finite `in` values substitute
 * exact candidate fields, and `array-contains` proves the corresponding positive
 * membership predicate only. Positive OR branches can supply a sufficient proof.
 * Every finite combination is evaluated through a document-independent residual,
 * including query-pinned lookup paths; unpinned reads are never fabricated.
 * Unbounded ranges, dynamic document-dependent collections, candidate identities,
 * and unsupported syntax still fail closed. The finite expansion is capped at 30.
 */
import { assembleExpression } from '../grammar/FirestoreAssembler.js';
import type { Expression, FunctionDef, SourceLoc } from '../grammar/FirestoreAST.js';
import { analyzeListRulePathInvariance } from './list-rule-path-proof.js';
import { getValidFunctionLexicalScope, type FunctionScopeBindings } from './match-resolution.js';
import {
  computeFieldFilterSets,
  computeWhereDomains,
  isSafePrecisionRulesScalar,
  isScalar,
  queryResidual,
  resolveStaticRulesOperand,
  rulesScalarToJsScalar,
  toRulesQueryScalar,
  type PathInvarianceContext,
  type RulesScalar,
  type Scalar,
} from './query-proof-residual.js';
import {
  callsResolveInOuterScope,
  dataFieldPath,
  inlineFunctionsInExpr,
  isProvablyDocIndependent,
  isRequestAuthUid,
  lexicalCaptureLiteralBindings,
  substituteIdentifiers,
} from './query-proof-scope.js';
import { rulesValuesEqual } from './value-equality.js';

/** A single `where(field, op, value)` constraint carried by the query. */
export interface QueryWhereConstraint {
  readonly field: string;
  readonly op: string;
  readonly value: string | number | boolean | null | readonly (string | number | boolean | null)[];
}

/** The query constraints relevant to the proof. `where` is the load-bearing
 *  one; limit/offset/orderBy are carried for completeness + future range
 *  proofs (and already populate `request.query`). */
export interface QueryConstraints {
  readonly where?: readonly QueryWhereConstraint[];
  readonly limit?: number | null;
  readonly offset?: number | null;
  readonly orderBy?: Readonly<Record<string, 'ASC' | 'DESC'>> | string | null;
}

/** A per-doc equality the rule requires that no query `where` guarantees. */
export interface QueryProofMissing {
  /** The `resource.data.<field>` the rule pins. */
  field: string;
  /** The value the rule requires the field to equal. When `fromAuthUid` is
   *  true this is the caller's uid (the rule pinned `== request.auth.uid`). */
  expectedValue: unknown;
  /** True when the required value came from `request.auth.uid` so remediation
   *  suggests `where(field, '==', request.auth.uid)` rather than a literal. */
  fromAuthUid: boolean;
}

/** A required equality the query filters on the right field but the wrong value. */
export interface QueryProofMismatch {
  field: string;
  expectedValue: unknown;
  actualValue: unknown;
}

/**
 * Structured account of why a doc-dependent query is unprovable. Empty `missing`
 * and `mismatched` with `outOfScope` set means the rule's doc-dependence is a
 * shape equality analysis cannot discharge, so no query constraint could prove it.
 */
export interface QueryProofResidual {
  missing: QueryProofMissing[];
  mismatched: QueryProofMismatch[];
  outOfScope?: string;
  /** Inlined predicate that stopped proof, not a runtime evaluation. */
  predicate?: string;
  predicateLoc?: SourceLoc;
}

export type QueryProofResult =
  | {
      provable: true;
      reason: string;
      residualCondition?: Expression;
      proofFailure?: {
        kind: 'unsupported-predicate' | 'constraints-not-satisfied' | 'unsupported-path';
        reason: string;
        residual: QueryProofResidual;
      };
    }
  | {
      provable: false;
      kind: 'unsupported-predicate' | 'constraints-not-satisfied' | 'unsupported-path';
      reason: string;
      residual: QueryProofResidual;
    };

/**
 * Decide whether `condition` is provable for every doc the query could
 * return, given its `constraints`. Pure: no evaluation context, no I/O.
 */
export function evaluateQueryProof(
  condition: Expression,
  constraints: QueryConstraints,
  functions: ReadonlyMap<string, FunctionDef> = new Map(),
  authUid?: string,
  pathVariables?: Readonly<Record<string, string>>,
  functionScopes?: ReadonlyMap<FunctionDef, FunctionScopeBindings>,
  pathInvariance?: PathInvarianceContext,
): QueryProofResult {
  const wholeRulePathInvariant =
    !pathInvariance ||
    analyzeListRulePathInvariance(
      condition,
      pathInvariance.candidateVariables,
      functions,
      pathInvariance.ambiguousNames,
      functionScopes,
    ).pathInvariant;
  if (!wholeRulePathInvariant) {
    const pathFailure: Extract<QueryProofResult, { provable: false }> = {
      provable: false,
      kind: 'unsupported-path',
      reason: 'list rule depends on the candidate document path',
      residual: { missing: [], mismatched: [] },
    };
    const residual = queryResidual(
      condition,
      constraints,
      functions,
      authUid,
      pathVariables,
      functionScopes,
      pathInvariance,
    );
    if (!residual) return pathFailure;
    const result: QueryProofResult = {
      provable: true,
      reason: 'query-guaranteed facts reduce every candidate alternative to a document-independent residual',
      residualCondition: residual.condition,
    };
    if (residual.partial) result.proofFailure = pathFailure;
    return result;
  }
  const equality = evaluateEqualityQueryProof(
    condition,
    constraints,
    functions,
    authUid,
    pathVariables,
    functionScopes,
  );
  if (equality.provable || equality.kind === 'constraints-not-satisfied') return equality;
  const residual = queryResidual(
    condition,
    constraints,
    functions,
    authUid,
    pathVariables,
    functionScopes,
    pathInvariance,
  );
  if (residual) {
    const result: QueryProofResult = {
      provable: true,
      reason: 'query-guaranteed facts reduce every candidate alternative to a document-independent residual',
      residualCondition: residual.condition,
    };
    if (residual.partial) {
      result.proofFailure = equality;
    }
    return result;
  }
  return equality;
}

function evaluateEqualityQueryProof(
  listCondition: Expression,
  constraints: QueryConstraints,
  fnMap: ReadonlyMap<string, FunctionDef> = new Map(),
  authUid?: string,
  pathVariables?: Readonly<Record<string, string>>,
  functionScopes?: ReadonlyMap<FunctionDef, FunctionScopeBindings>,
): QueryProofResult {
  // 1. Doc-independent rule -> any query is provable.
  if (isProvablyDocIndependent(listCondition, fnMap)) {
    return {
      provable: true,
      reason: 'list rule does not depend on per-document data; every doc is equally readable',
    };
  }

  // 2. Doc-dependent rule: walk the full inlined `&&` spine and verify every
  //    conjunct is either doc-independent or an extracted equality.
  const extraction = extractRequiredDataEqualities(
    listCondition,
    fnMap,
    authUid,
    pathVariables,
    functionScopes,
  );
  if (!extraction.ok || extraction.required.length === 0) {
    const outOfScope =
      'list rule depends on per-document data through a predicate the query cannot discharge ' +
      '(unconstrained candidate fields or unsupported query facts remain after helper expansion)';
    const residualInfo: QueryProofResidual = { missing: [], mismatched: [], outOfScope };
    if (!extraction.ok) {
      residualInfo.predicate = assembleExpression(extraction.predicate);
      if (extraction.predicateLoc !== undefined) {
        residualInfo.predicateLoc = extraction.predicateLoc;
      }
    }
    return {
      provable: false,
      kind: 'unsupported-predicate',
      reason: `${outOfScope} — Pyric cannot establish whether Firebase would allow this query`,
      residual: residualInfo,
    };
  }
  const required = extraction.required;

  const wheres = constraints.where ?? [];
  const filterSetsByField = computeFieldFilterSets(constraints);
  const domains = computeWhereDomains(constraints);
  const missing: QueryProofMissing[] = [];
  const mismatched: QueryProofMismatch[] = [];
  let needsResidualProjection = false;
  for (const req of required) {
    const domain = domains.get(req.field);
    const filterSets = filterSetsByField.get(req.field);
    const impliedByIntersection =
      domain !== undefined &&
      domain.length > 0 &&
      domain.every((v) => rulesValuesEqual(toRulesQueryScalar(v), req.rulesValue));
    const impliedByFilter =
      filterSets !== undefined &&
      filterSets.some(
        (set) => set.length > 0 && set.every((v) => rulesValuesEqual(toRulesQueryScalar(v), req.rulesValue)),
      );
    const discharged = impliedByIntersection || impliedByFilter;
    if (discharged) {
      if ((domain?.length ?? 0) !== 1) needsResidualProjection = true;
      continue;
    }
    const conflict = wheres.find(
      (w) =>
        w.field === req.field &&
        w.op === '==' &&
        isScalar(w.value) &&
        !rulesValuesEqual(toRulesQueryScalar(w.value), req.rulesValue),
    );
    if (conflict) {
      mismatched.push({ field: req.field, expectedValue: req.value, actualValue: conflict.value });
    } else {
      missing.push({ field: req.field, expectedValue: req.value, fromAuthUid: req.fromAuthUid });
    }
  }

  if (missing.length === 0 && mismatched.length === 0) {
    const provableResult: QueryProofResult = {
      provable: true,
      reason: 'every per-document predicate the rule requires is guaranteed by a query where(...) constraint',
    };
    if (needsResidualProjection) {
      provableResult.residualCondition = extraction.residual;
    }
    return provableResult;
  }

  return {
    provable: false,
    kind: 'constraints-not-satisfied',
    reason: buildResidualReason(missing, mismatched),
    residual: { missing, mismatched },
  };
}

/** Prose derived from the structured residual, for logs and legacy consumers. */
function buildResidualReason(missing: QueryProofMissing[], mismatched: QueryProofMismatch[]): string {
  const parts: string[] = [];
  if (missing.length > 0) {
    const list = missing
      .map((m) => {
        let expected = JSON.stringify(m.expectedValue);
        if (m.fromAuthUid) expected = 'request.auth.uid';
        return `resource.data.${m.field} == ${expected}`;
      })
      .join(', ');
    parts.push(`the query has no matching where(...) equality for [${list}]`);
  }
  if (mismatched.length > 0) {
    const list = mismatched
      .map((m) => `resource.data.${m.field} == ${JSON.stringify(m.expectedValue)} but the query pins ${JSON.stringify(m.actualValue)}`)
      .join(', ');
    parts.push(`the query where(...) value does not match [${list}]`);
  }
  return `${parts.join('; ')} — Pyric cannot prove the query safe ("rules are not filters")`;
}

/** A per-doc equality required by the rule, with provenance for remediation. */
interface RequiredEquality {
  field: string;
  value: Scalar;
  rulesValue: RulesScalar;
  fromAuthUid: boolean;
}

type ExtractionResult =
  | { ok: true; required: RequiredEquality[]; residual: Expression }
  | { ok: false; predicate: Expression; predicateLoc?: SourceLoc };

function extractRequiredDataEqualities(
  expr: Expression,
  fnMap: ReadonlyMap<string, FunctionDef>,
  authUid: string | undefined,
  pathVariables?: Readonly<Record<string, string>>,
  functionScopes?: ReadonlyMap<FunctionDef, FunctionScopeBindings>,
): ExtractionResult {
  const required: RequiredEquality[] = [];
  let predicate = expr;
  let predicateLoc = expr.loc;
  const walkAnd = (
    e: Expression,
    currentFnMap: ReadonlyMap<string, FunctionDef>,
    visited: ReadonlySet<FunctionDef>,
    enclosingLoc = expr.loc,
  ): Expression | null => {
    if (e.type === 'binaryOp' && e.op === '&&') {
      const left = walkAnd(e.left, currentFnMap, visited, enclosingLoc);
      if (!left) return null;
      const right = walkAnd(e.right, currentFnMap, visited, enclosingLoc);
      if (!right) return null;
      return { type: 'binaryOp', op: '&&', left, right };
    }
    if (e.type === 'functionCall' && currentFnMap.has(e.name)) {
      const fn = currentFnMap.get(e.name)!;
      if (visited.has(fn) || fn.parameters.length !== e.args.length) {
        predicate = e;
        predicateLoc = e.loc ?? enclosingLoc;
        return null;
      }
      const nextFnMap = getValidFunctionLexicalScope(fn, currentFnMap);
      if (!nextFnMap) {
        predicate = e;
        predicateLoc = e.loc ?? enclosingLoc;
        return null;
      }
      const bindings = lexicalCaptureLiteralBindings(fn, functionScopes);
      for (let i = 0; i < fn.parameters.length; i++) {
        const arg = e.args[i]!;
        let callerExpandedArg = arg;
        if (currentFnMap !== nextFnMap && !callsResolveInOuterScope(arg, currentFnMap, nextFnMap)) {
          const inlinedArg = inlineFunctionsInExpr(arg, currentFnMap, visited, functionScopes);
          if (!inlinedArg || !callsResolveInOuterScope(inlinedArg, currentFnMap, nextFnMap)) {
            predicate = e;
            predicateLoc = e.loc ?? enclosingLoc;
            return null;
          }
          callerExpandedArg = inlinedArg;
        }
        bindings.set(fn.parameters[i]!, callerExpandedArg);
      }
      for (const b of fn.lets) bindings.set(b.name, substituteIdentifiers(b.value, bindings));
      const inlined = substituteIdentifiers(fn.body, bindings);
      const nextVisited = new Set(visited).add(fn);
      return walkAnd(inlined, nextFnMap, nextVisited, fn.loc ?? enclosingLoc);
    }
    const eq = asDataEquality(e, currentFnMap, authUid, visited, pathVariables, functionScopes);
    if (eq) {
      required.push(eq);
      return { type: 'literal', value: true, raw: 'true' };
    }
    let residualLeaf = e;
    if (currentFnMap !== fnMap && !callsResolveInOuterScope(e, currentFnMap, fnMap)) {
      const inlinedLeaf = inlineFunctionsInExpr(e, currentFnMap, visited, functionScopes);
      if (!inlinedLeaf || !callsResolveInOuterScope(inlinedLeaf, currentFnMap, fnMap)) {
        predicate = e;
        predicateLoc = e.loc ?? enclosingLoc;
        return null;
      }
      residualLeaf = inlinedLeaf;
    }
    const independent = isProvablyDocIndependent(residualLeaf, fnMap);
    if (!independent) {
      predicate = e;
      predicateLoc = e.loc ?? enclosingLoc;
      return null;
    }
    return residualLeaf;
  };
  const residual = walkAnd(expr, fnMap, new Set());
  if (residual) {
    return { ok: true, required, residual };
  }
  return { ok: false, predicate, predicateLoc };
}

function asDataEquality(
  rawExpr: Expression,
  fnMap: ReadonlyMap<string, FunctionDef>,
  authUid: string | undefined,
  visited: ReadonlySet<FunctionDef>,
  pathVariables?: Readonly<Record<string, string>>,
  functionScopes?: ReadonlyMap<FunctionDef, FunctionScopeBindings>,
): RequiredEquality | null {
  const e = inlineFunctionsInExpr(rawExpr, fnMap, visited, functionScopes);
  if (!e || e.type !== 'binaryOp' || e.op !== '==') return null;
  const fromSide = (data: Expression, other: Expression): RequiredEquality | null => {
    const field = dataFieldPath(data);
    if (field === null) return null;
    if (isRequestAuthUid(other)) {
      if (authUid === undefined) return null;
      return { field, value: authUid, rulesValue: authUid, fromAuthUid: true };
    }
    const resolved = resolveStaticRulesOperand(other, fnMap, authUid, pathVariables, functionScopes);
    if (resolved === undefined || !isSafePrecisionRulesScalar(resolved)) return null;
    return {
      field,
      value: rulesScalarToJsScalar(resolved),
      rulesValue: resolved,
      fromAuthUid: false,
    };
  };
  return fromSide(e.left, e.right) ?? fromSide(e.right, e.left);
}
