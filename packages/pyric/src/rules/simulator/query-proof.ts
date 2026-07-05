/**
 * RULES-B11 (rules-side) — query-proof evaluation for `list` operations.
 *
 * Production Firestore enforces "rules are NOT filters." For a query (`list`),
 * the engine does not run the rule per-document and silently drop the docs that
 * fail — it evaluates the rule ONCE against the query itself, and rejects the
 * WHOLE query unless the rules can PROVE that every document the query could
 * return is readable. A query the rules can't prove safe is denied outright (a
 * `permission-denied` error), never silently truncated.
 *
 *   docs: https://firebase.google.com/docs/firestore/security/rules-query
 *   "Rules are not filters … the query must be guaranteed to return only
 *    documents that the rules allow the client to read. Otherwise the request
 *    fails — even if the actual result set would have been allowed."
 *
 * THIS MODULE is the pure rules-side decision: given a collection's `list`
 * allow-rule condition and the query's constraints, decide PROVABLE or REJECT.
 * It is the function the firestore-track listener/read path
 * (`sandbox/firestore/local-environment.ts:silentReadCollection`) should call
 * INSTEAD of the current per-doc "rules-as-filters" loop — wiring that lives in
 * T2's carve-out and is STOP-documented for hand-off (see the round-2 step doc).
 *
 * Scope of the proof here (the well-documented, decidable core):
 *  - A `list` rule that does NOT depend on per-document data
 *    (`resource.data.*`) — only `request.auth`, `request.query`, constants,
 *    path variables — is doc-independent: if it evaluates ALLOW, EVERY doc is
 *    equally allowed, so any query shape is provable.
 *  - A rule that REQUIRES a per-document predicate (`resource.data.<field> ==
 *    <const>`, conjoined into the condition) is provable ONLY IF the query
 *    carries a `where(<field>, <op>, <const>)` constraint that guarantees the
 *    same predicate. Otherwise the query could return a non-matching doc, so
 *    prod rejects it — we return `provable: false`.
 *
 * Out of scope (documented as conservative REJECT, never a false ALLOW): rules
 * with disjunctions over doc data, inequality/range proofs, function-inlined
 * data predicates. When the rule's doc-dependence can't be discharged by a
 * direct `where` equality match, we reject — the safe direction (prod also
 * rejects an unprovable query).
 */
import type { Expression, FunctionDef } from '../grammar/FirestoreAST.js';

/** A single `where(field, op, value)` constraint carried by the query. */
export interface QueryWhereConstraint {
  field: string;
  op: string;
  value: string | number | boolean | null;
}

/** The query constraints relevant to the proof. `where` is the load-bearing
 *  one; limit/offset/orderBy are carried for completeness + future range
 *  proofs (and already populate `request.query`). */
export interface QueryConstraints {
  where?: QueryWhereConstraint[];
  limit?: number | null;
  offset?: number | null;
  orderBy?: string | null;
}

export type QueryProofResult =
  | { provable: true; reason: string }
  | { provable: false; reason: string };

/**
 * Decide whether `listCondition` is PROVABLE for every doc the query could
 * return, given its `constraints`. Pure — no evaluation context, no I/O.
 *
 * @param listCondition the `allow list/read` rule's condition AST (already the
 *   specific list rule; OR-of-rules is the caller's concern — it asks per rule).
 * @param constraints   the query's where/limit/offset/orderBy.
 * @param fnMap         user-defined functions, for inlining doc-dependence checks.
 */
export function evaluateQueryProof(
  listCondition: Expression,
  constraints: QueryConstraints,
  fnMap: Map<string, FunctionDef> = new Map(),
): QueryProofResult {
  // 1. Doc-independent rule → any query is provable. This is the common
  //    `allow list: if request.auth != null` / `if true` case.
  if (!referencesResourceData(listCondition, fnMap)) {
    return {
      provable: true,
      reason: 'list rule does not depend on per-document data; every doc is equally readable',
    };
  }

  // 2. Doc-dependent rule. Extract the per-doc equality predicates the rule
  //    REQUIRES (top-level `&&` conjuncts of the form `resource.data.F == V`),
  //    and check each is guaranteed by a matching `where` equality constraint.
  const required = extractRequiredDataEqualities(listCondition);
  if (required.length === 0) {
    // The rule touches resource.data but not via a discharge-able top-level
    // equality (e.g. inequality, disjunction, function-wrapped). Conservatively
    // reject — prod also rejects a query it can't prove.
    return {
      provable: false,
      reason:
        'list rule depends on per-document data through a predicate the query cannot discharge ' +
        '(only top-level `resource.data.field == value` conjunctions are provable here) — ' +
        'prod rejects the whole query rather than filtering',
    };
  }

  const wheres = constraints.where ?? [];
  const unproven = required.filter(
    req => !wheres.some(w => w.field === req.field && w.op === '==' && valuesEqual(w.value, req.value)),
  );
  if (unproven.length > 0) {
    const list = unproven.map(r => `resource.data.${r.field} == ${JSON.stringify(r.value)}`).join(', ');
    return {
      provable: false,
      reason:
        `list rule requires [${list}] but the query has no matching where(...) ` +
        `equality to guarantee it — prod rejects the query ("rules are not filters")`,
    };
  }

  return {
    provable: true,
    reason: 'every per-document predicate the rule requires is guaranteed by a query where(...) constraint',
  };
}

/**
 * True if the expression depends on `resource.data` (the per-document data of
 * the candidate doc) — directly or via an inlined user function. Mirrors the
 * shape of `referencesRequestTime` in linter/ast-utils. `request.resource.data`
 * (the WRITE payload) is NOT per-doc-read data, so it's intentionally excluded.
 */
export function referencesResourceData(
  expr: Expression,
  fnMap: Map<string, FunctionDef> = new Map(),
  visited = new Set<string>(),
): boolean {
  const check = (e: Expression): boolean => {
    switch (e.type) {
      case 'memberAccess':
        // `resource.data` (the bare `resource` identifier, not `request.resource`).
        if (e.property === 'data' && e.object.type === 'identifier' && e.object.name === 'resource') {
          return true;
        }
        return check(e.object);
      case 'bracketAccess':
        return check(e.object) || check(e.index);
      case 'functionCall':
        if (fnMap.has(e.name) && !visited.has(e.name)) {
          visited.add(e.name);
          const fn = fnMap.get(e.name)!;
          if (referencesResourceData(fn.body, fnMap, visited)) return true;
          if (fn.lets.some(b => referencesResourceData(b.value, fnMap, visited))) return true;
        }
        return e.args.some(check);
      case 'binaryOp': return check(e.left) || check(e.right);
      case 'unaryOp': return check(e.operand);
      case 'methodCall': return check(e.object) || e.args.some(check);
      case 'ternary': return check(e.condition) || check(e.consequent) || check(e.alternate);
      case 'inExpr': return check(e.element) || check(e.collection);
      case 'isExpr': return check(e.value);
      case 'listLiteral': return e.elements.some(check);
      case 'mapLiteral': return e.entries.some(en => check(en.key) || check(en.value));
      default: return false;
    }
  };
  return check(expr);
}

/**
 * Pull out the per-doc EQUALITY predicates the rule requires: top-level `&&`
 * conjuncts shaped `resource.data.<field> == <literal>` (either operand order).
 * Only the conjunctive (AND) spine is walked — a disjunction (`||`) anywhere
 * means the predicate isn't unconditionally required, so we don't extract from
 * under it (the caller then conservatively rejects).
 */
function extractRequiredDataEqualities(expr: Expression): QueryWhereConstraint[] {
  const out: QueryWhereConstraint[] = [];
  const walkAnd = (e: Expression) => {
    if (e.type === 'binaryOp' && e.op === '&&') {
      walkAnd(e.left);
      walkAnd(e.right);
      return;
    }
    const eq = asDataEquality(e);
    if (eq) out.push(eq);
  };
  walkAnd(expr);
  return out;
}

/** Match `resource.data.<field> == <literal>` (either operand order) → constraint. */
function asDataEquality(e: Expression): QueryWhereConstraint | null {
  if (e.type !== 'binaryOp' || e.op !== '==') return null;
  const fromSide = (data: Expression, lit: Expression): QueryWhereConstraint | null => {
    const field = dataFieldPath(data);
    if (field !== null && lit.type === 'literal') {
      return { field, op: '==', value: lit.value };
    }
    return null;
  };
  return fromSide(e.left, e.right) ?? fromSide(e.right, e.left);
}

/**
 * If `e` is a single-segment `resource.data.<field>` access, return `<field>`;
 * otherwise null. Nested paths (`resource.data.a.b`) aren't dischargeable by a
 * flat `where('a.b', ...)` equality here, so they return null → reject.
 */
function dataFieldPath(e: Expression): string | null {
  if (
    e.type === 'memberAccess' &&
    e.object.type === 'memberAccess' &&
    e.object.property === 'data' &&
    e.object.object.type === 'identifier' &&
    e.object.object.name === 'resource'
  ) {
    return e.property;
  }
  return null;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return a === b;
}
