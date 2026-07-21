/**
 * RULES-B11 (enforcement wiring) — query-proof gate for `list` reads.
 *
 * Production Firestore enforces "rules are NOT filters": a query (`list`)
 * is evaluated ONCE against its potential result set and REJECTED outright
 * when the rules can't prove every returnable doc is readable — it is never
 * silently truncated to the readable subset, and per-doc `get` rules never
 * filter query results (the `list` rule alone governs queries).
 *
 *   docs: https://firebase.google.com/docs/firestore/security/rules-query
 *   "Rules are not filters … the query must be guaranteed to return only
 *    documents that the rules allow the client to read. Otherwise the
 *    request fails — even if the actual result set would have been allowed."
 *
 * The pure PROVABLE-or-REJECT decision lives in the rules track's
 * `rules/simulator/query-proof.ts` (landed in #547, step-13). THIS module is
 * the firestore-side wiring that step-13 STOP-documented: it resolves which
 * `list`/`read` rules match a collection path (using the simulator's shared
 * match collector), asks `evaluateQueryProof` per rule (OR semantics),
 * and hands `LocalEnvironment` everything it needs to either DENY the whole
 * query or run the residual (auth/time/query) evaluation through the
 * ordinary `simulate()` call.
 *
 * Residual evaluation trick: when a rule is provable BECAUSE the query's
 * `where(field, ==, value)` constraints pin the per-doc fields it reads, we
 * synthesize `resource.data` from exactly those pinned equalities and let the
 * simulator evaluate the rule against it. This mirrors prod's "evaluate
 * against the potential result set": every doc the query can return carries
 * those field values, so the synthetic doc is a faithful representative. Any
 * `resource.data` access the equalities do NOT pin errors in the evaluator
 * and the rule denies — the conservative (prod-safe) direction.
 */
import type {
  AllowRule,
  FirestoreRules,
  FunctionDef,
  MatchBlock,
} from 'pyric/rules/internal';
import {
  evaluateQueryProof,
  type QueryConstraints,
  type QueryProofResidual,
  type QueryWhereConstraint,
} from '../../rules/simulator/query-proof.js';
import { collectMatches, type MatchResult } from '../../rules/simulator/handler.js';

export type { QueryConstraints, QueryProofResidual, QueryWhereConstraint };

/** Auth shape the sandbox threads through reads (`Operation['auth']`). */
type ReadAuth = { uid: string; token?: Record<string, unknown> } | null;

/** What the proof decided for a `list` request. */
export type ListProofVerdict =
  /** At least one matching `list`/`read` rule is provable for this query.
   *  Residual evaluation MUST use only `evaluationAst`, which removes
   *  unprovable sibling rules that could otherwise allow from local state.
   *  `syntheticResource` is independent of any user-addressable placeholder
   *  document and contains only query-pinned equality fields. */
  | {
      kind: 'provable';
      evaluationAst: FirestoreRules;
      syntheticResource: Record<string, unknown>;
    }
  /** Every matching rule depends on per-document data the query's
   *  constraints cannot guarantee — prod rejects the WHOLE query.
   *  `residual` is the structured account (missing / mismatched equalities,
   *  or an out-of-scope shape) that the denial site renders remediation from. */
  | { kind: 'unprovable'; reason: string; residual: QueryProofResidual }
  /** No match block / no list rules — let simulate() default-deny exactly
   *  as it does today (the proof has nothing to add). */
  | { kind: 'no-rule' };

/**
 * Decide provability of a `list` on `relPath` (the placeholder doc path,
 * e.g. `posts/__listPlaceholder__`) under `auth` and the query's structured
 * `constraints`. Pure — parses nothing, reads no state.
 */
export function proveListQuery(
  ast: FirestoreRules | null,
  relPath: string,
  auth: ReadAuth,
  constraints: QueryConstraints,
): ListProofVerdict {
  if (!ast) return { kind: 'no-rule' };
  const segments = relPath.split('/').filter((s) => s.length > 0);
  // Like handler.ts, the root match (/databases/{db}/documents) is implicit:
  // resolution starts at its children with every enclosing helper in scope.
  const rootFunctions = [
    ...(ast.functions ?? []),
    ...(ast.service.functions ?? []),
    ...ast.service.match.functions,
  ];
  const matches: MatchResult[] = [];
  for (const child of ast.service.match.children) {
    matches.push(...collectMatches(child, segments, rootFunctions));
  }
  if (matches.length === 0) return { kind: 'no-rule' };

  // OR semantics across allow rules: ANY provable rule makes the query
  // provable. Residual simulation receives ONLY those provable rules, so an
  // unprovable sibling cannot grant from a concrete placeholder document.
  const failures: { reason: string; residual: QueryProofResidual }[] = [];
  const provableRules = new Set<AllowRule>();
  let applicableRuleCount = 0;
  for (const match of matches) {
    const fnMap = new Map<string, FunctionDef>();
    for (const fn of match.functions) {
      fnMap.set(fn.name, fn);
    }
    for (const rule of match.block.allows) {
      if (!rule.operations.some((op) => op === 'list' || op === 'read')) continue;
      applicableRuleCount++;
      // `auth.uid` is threaded into the proof so the canonical owner pattern
      // can be discharged by a matching query equality. Residual simulation
      // still evaluates the real auth value against the synthetic resource.
      const result = evaluateQueryProof(rule.condition, constraints, fnMap, auth?.uid);
      if (result.provable) {
        provableRules.add(rule);
      } else {
        failures.push({ reason: result.reason, residual: result.residual });
      }
    }
  }
  if (applicableRuleCount === 0) return { kind: 'no-rule' };
  if (provableRules.size === 0) {
    const first = failures[0];
    return {
      kind: 'unprovable',
      reason: first?.reason ?? 'list rule depends on per-document data the query cannot guarantee',
      residual: first?.residual ?? { missing: [], mismatched: [] },
    };
  }
  return {
    kind: 'provable',
    evaluationAst: projectRules(ast, provableRules),
    syntheticResource: syntheticResourceFromWheres(constraints),
  };
}

// ─── Proof/execution projection ──────────────────────────────────

/** Preserve match paths and helper scopes while removing every rule the
 * static proof did not approve. This keeps residual execution and proof on
 * the exact same set of potentially granting rules. */
function projectRules(ast: FirestoreRules, retained: ReadonlySet<AllowRule>): FirestoreRules {
  const projectBlock = (block: MatchBlock): MatchBlock => ({
    ...block,
    allows: block.allows.filter((rule) => retained.has(rule)),
    children: block.children.map(projectBlock),
  });
  return {
    ...ast,
    service: {
      ...ast.service,
      match: projectBlock(ast.service.match),
    },
  };
}

// ─── Synthetic resource construction ─────────────────────────────────────

/**
 * Build the representative `resource.data` for the residual evaluation:
 * exactly the fields the query pins with `where(field, ==, value)`. Fields
 * the query does not pin stay ABSENT, so a rule conjunct reading them errors
 * (→ deny) rather than passing vacuously.
 */
function syntheticResourceFromWheres(constraints: QueryConstraints): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const w of constraints.where ?? []) {
    if (w.op === '==') out[w.field] = w.value;
  }
  return out;
}

// ─── Remediation rendering ───────────────────────────────────────────────

/**
 * Render query-side, narrowing-only remediation from an unprovable query's
 * residual — the `where(...)` clauses the caller can ADD (or correct) so the
 * `list` rule's per-doc equalities are discharged. The suggestion never touches
 * the rule (weakening a rule is never the right fix for an over-broad query).
 *
 * Returns `undefined` when the residual is only an out-of-scope shape
 * (disjunction / range / `in` / nested path): no equality constraint can prove
 * it, so there is nothing narrowing to suggest.
 */
export function renderQueryRemediation(residual: QueryProofResidual): string | undefined {
  const lines: string[] = [];
  for (const m of residual.missing) {
    if (m.fromAuthUid) {
      lines.push(`  .where('${m.field}', '==', request.auth.uid)   // request.auth.uid is ${JSON.stringify(m.expectedValue)}`);
    } else {
      lines.push(`  .where('${m.field}', '==', ${JSON.stringify(m.expectedValue)})`);
    }
  }
  for (const m of residual.mismatched) {
    lines.push(
      `  .where('${m.field}', '==', ${JSON.stringify(m.expectedValue)})   ` +
      `// the query pins ${JSON.stringify(m.actualValue)}, but the rule requires ${JSON.stringify(m.expectedValue)}`,
    );
  }
  if (lines.length === 0) return undefined;
  const header =
    'The list rule requires per-document equalities the query does not guarantee. ' +
    'Add the matching where(...) constraint(s) so every returned document satisfies the rule:';
  return `${header}\n${lines.join('\n')}`;
}
