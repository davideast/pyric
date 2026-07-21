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
 * `list`/`read` rules match a collection path (mirroring the simulator's
 * `resolveMatch` walk), asks `evaluateQueryProof` per rule (OR semantics),
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
  referencesResourceData,
  type QueryConstraints,
  type QueryProofResidual,
  type QueryWhereConstraint,
} from '../../rules/simulator/query-proof.js';

export type { QueryConstraints, QueryProofResidual, QueryWhereConstraint };

/** Auth shape the sandbox threads through reads (`Operation['auth']`). */
type ReadAuth = { uid: string; token?: Record<string, unknown> } | null;

/** What the proof decided for a `list` request. */
export type ListProofVerdict =
  /** At least one matching `list`/`read` rule is provable for this query.
   *  `syntheticResource` is set when the provable rule depends on per-doc
   *  data — inject it as the test case's `resource` so the residual
   *  simulate() evaluation sees the query-pinned field values. */
  | { kind: 'provable'; syntheticResource?: Record<string, unknown> }
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
  // Mirror handler.ts: the root match (/databases/{db}/documents) is
  // implicit — resolution starts at its children, root functions in scope.
  const rootFunctions = ast.service.match.functions;
  let match: ResolvedMatch | null = null;
  for (const child of ast.service.match.children) {
    match = resolveMatchBlock(child, segments, rootFunctions);
    if (match) break;
  }
  if (!match) return { kind: 'no-rule' };

  const listRules = match.block.allows.filter((r) =>
    r.operations.some((op) => op === 'list' || op === 'read'),
  );
  if (listRules.length === 0) return { kind: 'no-rule' };

  const fnMap = new Map<string, FunctionDef>();
  for (const fn of match.functions) fnMap.set(fn.name, fn);

  // OR semantics across allow rules: ANY provable rule makes the query
  // provable (the residual simulate() run still has to evaluate it ALLOW).
  const failures: { reason: string; residual: QueryProofResidual }[] = [];
  let provable = false;
  let needsSynthetic = false;
  for (const rule of listRules) {
    // `auth.uid` is threaded into the proof so the canonical owner pattern —
    // `resource.data.owner == request.auth.uid` (directly or via a helper) with
    // a `where('owner', '==', <uid>)` clause — is provable, exactly as the prod
    // docs' example promises (rules-query: "secure and query documents based on
    // auth.uid"). The residual simulate() run still evaluates the real
    // `request.auth.uid` against the synthetic representative resource.
    const result = evaluateQueryProof(rule.condition, constraints, fnMap, auth?.uid);
    if (result.provable) {
      provable = true;
      if (referencesResourceData(rule.condition, fnMap)) needsSynthetic = true;
    } else {
      failures.push({ reason: result.reason, residual: result.residual });
    }
  }
  if (!provable) {
    const first = failures[0];
    return {
      kind: 'unprovable',
      reason: first?.reason ?? 'list rule depends on per-document data the query cannot guarantee',
      residual: first?.residual ?? { missing: [], mismatched: [] },
    };
  }
  if (!needsSynthetic) return { kind: 'provable' };
  return { kind: 'provable', syntheticResource: syntheticResourceFromWheres(constraints) };
}

// ─── Match-block resolution (mirrors simulator/handler.ts:resolveMatch) ──

interface ResolvedMatch {
  block: MatchBlock;
  /** Functions in scope for the matched block: root + ancestors + own. */
  functions: FunctionDef[];
}

/**
 * Walk one match block against the remaining path segments; recurse into
 * children. Same literal / `{wildcard}` / `{name=**}` consumption rules as
 * the simulator's `resolveMatch` (which is not exported — this mirrors it
 * so the proof gates the SAME block the simulate() call will evaluate).
 * Bindings are not collected: the proof never reads path variables.
 */
function resolveMatchBlock(
  block: MatchBlock,
  segments: string[],
  parentFunctions: FunctionDef[],
): ResolvedMatch | null {
  const functions = [...parentFunctions, ...block.functions];
  let consumed = 0;
  for (const seg of block.path.segments) {
    if (seg.type === 'literal') {
      if (consumed >= segments.length || segments[consumed] !== seg.value) return null;
      consumed++;
    } else if (seg.type === 'wildcard') {
      if (consumed >= segments.length) return null;
      consumed++;
    } else {
      // recursive `{name=**}` — consumes everything remaining.
      consumed = segments.length;
    }
  }
  const remaining = segments.slice(consumed);
  if (remaining.length === 0) return { block, functions };
  for (const child of block.children) {
    const childResult = resolveMatchBlock(child, remaining, functions);
    if (childResult) return childResult;
  }
  return null;
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
