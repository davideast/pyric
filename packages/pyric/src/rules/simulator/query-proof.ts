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
 * (`firestore/sandbox/rules-read-engine.ts silentReadCollection`) should call
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
 * with disjunctions over doc data, inequality/range proofs, and any predicate
 * that still can't be reduced to a top-level equality after user functions are
 * inlined (helpers ARE inlined — a helper whose body is an equality spine is
 * proven the same as if it were written inline). When the rule's doc-dependence
 * can't be discharged by a direct `where` equality match, we reject — the safe
 * direction (prod also rejects an unprovable query).
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

/** A per-doc equality the rule requires that no query `where` guarantees. */
export interface QueryProofMissing {
  /** The `resource.data.<field>` the rule pins. */
  field: string;
  /** The value the rule requires the field to equal. When `fromAuthUid` is
   *  true this is the caller's uid (the rule pinned `== request.auth.uid`). */
  expectedValue: unknown;
  /** True when the required value came from `request.auth.uid` — the remediation
   *  then suggests `where(field, '==', request.auth.uid)` rather than a literal. */
  fromAuthUid: boolean;
}

/** A required equality the query filters on the RIGHT field but the WRONG value. */
export interface QueryProofMismatch {
  field: string;
  expectedValue: unknown;
  actualValue: unknown;
}

/**
 * Structured account of WHY a doc-dependent query is unprovable — the machine
 * -readable companion to `reason` (which is derived from this). Empty `missing`
 * + `mismatched` with `outOfScope` set means the rule's doc-dependence is a
 * shape equality analysis can't discharge (disjunction / range / `in` / nested
 * path), so no query constraint could prove it — no suggestion is possible.
 */
export interface QueryProofResidual {
  missing: QueryProofMissing[];
  mismatched: QueryProofMismatch[];
  outOfScope?: string;
}

export type QueryProofResult =
  | { provable: true; reason: string }
  | { provable: false; reason: string; residual: QueryProofResidual };

/**
 * Decide whether `listCondition` is PROVABLE for every doc the query could
 * return, given its `constraints`. Pure — no evaluation context, no I/O.
 *
 * @param listCondition the `allow list/read` rule's condition AST (already the
 *   specific list rule; OR-of-rules is the caller's concern — it asks per rule).
 * @param constraints   the query's where/limit/offset/orderBy.
 * @param fnMap         user-defined functions, inlined during both the
 *   doc-dependence check and the required-equality extraction.
 * @param authUid       the caller's uid, so a rule pinning `resource.data.F ==
 *   request.auth.uid` (directly or through a helper) is dischargeable by a
 *   `where(F, '==', <that uid>)` clause. Absent (unauthenticated) → an
 *   `== request.auth.uid` predicate is not recognized as a required equality.
 */
export function evaluateQueryProof(
  listCondition: Expression,
  constraints: QueryConstraints,
  fnMap: Map<string, FunctionDef> = new Map(),
  authUid?: string,
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
  //    REQUIRES (top-level `&&` conjuncts of the form `resource.data.F == V`,
  //    inlining helper calls along the spine), and check each is guaranteed by
  //    a matching `where` equality constraint.
  const required = extractRequiredDataEqualities(listCondition, fnMap, authUid);
  if (required.length === 0) {
    // The rule touches resource.data but not via a discharge-able top-level
    // equality — even after inlining helpers — so the shape is out of scope
    // (inequality, disjunction, `in`, nested path). Conservatively reject; prod
    // also rejects a query it can't prove.
    const outOfScope =
      'list rule depends on per-document data through a predicate the query cannot discharge ' +
      '(only top-level `resource.data.field == value` conjunctions, including through inlined ' +
      'helpers, are provable here — disjunctions, ranges, `in`, and nested paths are not)';
    return {
      provable: false,
      reason: `${outOfScope} — prod rejects the whole query rather than filtering`,
      residual: { missing: [], mismatched: [], outOfScope },
    };
  }

  const wheres = constraints.where ?? [];
  const missing: QueryProofMissing[] = [];
  const mismatched: QueryProofMismatch[] = [];
  for (const req of required) {
    const discharged = wheres.some(
      w => w.field === req.field && w.op === '==' && valuesEqual(w.value, req.value),
    );
    if (discharged) continue;
    // A `where(field, '==', other)` on the same field with a different value is
    // a mismatch (actionable: the wrong value); anything else is simply missing.
    const conflict = wheres.find(w => w.field === req.field && w.op === '==');
    if (conflict) {
      mismatched.push({ field: req.field, expectedValue: req.value, actualValue: conflict.value });
    } else {
      missing.push({ field: req.field, expectedValue: req.value, fromAuthUid: req.fromAuthUid });
    }
  }

  if (missing.length === 0 && mismatched.length === 0) {
    return {
      provable: true,
      reason: 'every per-document predicate the rule requires is guaranteed by a query where(...) constraint',
    };
  }

  return {
    provable: false,
    reason: buildResidualReason(missing, mismatched),
    residual: { missing, mismatched },
  };
}

/** Prose derived from the structured residual, for logs and legacy consumers. */
function buildResidualReason(missing: QueryProofMissing[], mismatched: QueryProofMismatch[]): string {
  const parts: string[] = [];
  if (missing.length > 0) {
    const list = missing
      .map(m => `resource.data.${m.field} == ${m.fromAuthUid ? 'request.auth.uid' : JSON.stringify(m.expectedValue)}`)
      .join(', ');
    parts.push(`the query has no matching where(...) equality for [${list}]`);
  }
  if (mismatched.length > 0) {
    const list = mismatched
      .map(m => `resource.data.${m.field} == ${JSON.stringify(m.expectedValue)} but the query pins ${JSON.stringify(m.actualValue)}`)
      .join(', ');
    parts.push(`the query where(...) value does not match [${list}]`);
  }
  return `${parts.join('; ')} — prod rejects the query ("rules are not filters")`;
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

/** A per-doc equality required by the rule, with provenance for remediation. */
interface RequiredEquality {
  field: string;
  value: unknown;
  fromAuthUid: boolean;
}

/**
 * Pull out the per-doc EQUALITY predicates the rule requires: top-level `&&`
 * conjuncts shaped `resource.data.<field> == <literal>` or `resource.data.<field>
 * == request.auth.uid` (either operand order). User functions on the spine are
 * INLINED — a `functionCall` in `fnMap` has its argument expressions substituted
 * for the function's parameters (and its `let` bindings resolved in that scope),
 * then the inlined body's own `&&` spine is walked. A `visited` set guards
 * against recursion (helper calling helper, or a self-referential helper).
 *
 * Only the conjunctive (AND) spine is walked — a disjunction (`||`) anywhere
 * means the predicate isn't unconditionally required, so we don't extract from
 * under it (the caller then conservatively rejects).
 */
function extractRequiredDataEqualities(
  expr: Expression,
  fnMap: Map<string, FunctionDef>,
  authUid: string | undefined,
): RequiredEquality[] {
  const out: RequiredEquality[] = [];
  const walkAnd = (e: Expression, visited: Set<string>) => {
    if (e.type === 'binaryOp' && e.op === '&&') {
      walkAnd(e.left, visited);
      walkAnd(e.right, visited);
      return;
    }
    if (e.type === 'functionCall' && fnMap.has(e.name) && !visited.has(e.name)) {
      const fn = fnMap.get(e.name)!;
      // Bind parameters to the call's argument expressions, then resolve `let`
      // bindings in that scope (a let can reference params + earlier lets).
      const bindings = new Map<string, Expression>();
      fn.parameters.forEach((p, i) => {
        const arg = e.args[i];
        if (arg) bindings.set(p, arg);
      });
      for (const b of fn.lets) bindings.set(b.name, substituteIdentifiers(b.value, bindings));
      const inlined = substituteIdentifiers(fn.body, bindings);
      const nextVisited = new Set(visited).add(e.name);
      walkAnd(inlined, nextVisited);
      return;
    }
    const eq = asDataEquality(e, authUid);
    if (eq) out.push(eq);
  };
  walkAnd(expr, new Set());
  return out;
}

/**
 * Match `resource.data.<field> == <literal>` or `resource.data.<field> ==
 * request.auth.uid` (either operand order) → the required equality. The auth
 * form is only recognized when `authUid` is known; its value is that uid and
 * `fromAuthUid` is set so remediation can suggest `request.auth.uid`.
 */
function asDataEquality(e: Expression, authUid: string | undefined): RequiredEquality | null {
  if (e.type !== 'binaryOp' || e.op !== '==') return null;
  const fromSide = (data: Expression, other: Expression): RequiredEquality | null => {
    const field = dataFieldPath(data);
    if (field === null) return null;
    if (other.type === 'literal') return { field, value: other.value, fromAuthUid: false };
    if (authUid !== undefined && isRequestAuthUid(other)) return { field, value: authUid, fromAuthUid: true };
    return null;
  };
  return fromSide(e.left, e.right) ?? fromSide(e.right, e.left);
}

/** True for the exact member chain `request.auth.uid`. */
function isRequestAuthUid(e: Expression): boolean {
  return (
    e.type === 'memberAccess' &&
    e.property === 'uid' &&
    e.object.type === 'memberAccess' &&
    e.object.property === 'auth' &&
    e.object.object.type === 'identifier' &&
    e.object.object.name === 'request'
  );
}

/**
 * Return a copy of `expr` with every free `identifier` whose name is a key in
 * `bindings` replaced by the bound expression. Used to inline a function body:
 * its parameters and `let` names are identifiers, and this substitutes the
 * call's argument expressions for them. Pure structural map — the shared AST is
 * never mutated.
 */
function substituteIdentifiers(expr: Expression, bindings: Map<string, Expression>): Expression {
  const sub = (e: Expression): Expression => {
    switch (e.type) {
      case 'identifier':
        return bindings.get(e.name) ?? e;
      case 'literal':
        return e;
      case 'memberAccess':
        return { ...e, object: sub(e.object) };
      case 'methodCall':
        return { ...e, object: sub(e.object), args: e.args.map(sub) };
      case 'bracketAccess':
        return { ...e, object: sub(e.object), index: sub(e.index) };
      case 'sliceAccess':
        return { ...e, object: sub(e.object), start: sub(e.start), end: sub(e.end) };
      case 'binaryOp':
        return { ...e, left: sub(e.left), right: sub(e.right) };
      case 'unaryOp':
        return { ...e, operand: sub(e.operand) };
      case 'ternary':
        return { ...e, condition: sub(e.condition), consequent: sub(e.consequent), alternate: sub(e.alternate) };
      case 'inExpr':
        return { ...e, element: sub(e.element), collection: sub(e.collection) };
      case 'isExpr':
        return { ...e, value: sub(e.value) };
      case 'listLiteral':
        return { ...e, elements: e.elements.map(sub) };
      case 'mapLiteral':
        return { ...e, entries: e.entries.map((en) => ({ key: sub(en.key), value: sub(en.value) })) };
      case 'pathLiteral':
        return { ...e, segments: e.segments.map((s) => (typeof s === 'string' ? s : sub(s))) };
      case 'functionCall':
        return { ...e, args: e.args.map(sub) };
    }
  };
  return sub(expr);
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
