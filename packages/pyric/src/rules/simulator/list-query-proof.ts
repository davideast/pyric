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
 * The pure PROVABLE-or-REJECT decision lives in `rules/simulator/query-proof.ts`.
 * This module resolves which `list`/`read` rules match a collection path
 * (using the simulator's shared match collector), asks `evaluateQueryProof`
 * per rule (OR semantics), and provides both the simulator's `queryProof`
 * report and the sandbox's `RulesListAuthorizer` proof + repro rendering.
 */
import { assembleExpression as printExpression } from '../grammar/FirestoreAssembler.js';
import type {
  AllowRule,
  FirestoreRules,
  MatchBlock,
} from '../grammar/FirestoreAST.js';
import { resolveAuthoredSourceLoc } from '../modules/resolver-core.js';
import type { EvaluatedRuleInfo, ListQuery } from '../test/spec.js';
import { collectMatches, type MatchResult } from './match-resolution.js';
import {
  evaluateQueryProof,
  type QueryConstraints,
  type QueryProofResidual,
  type QueryWhereConstraint,
} from './query-proof.js';
import { computeWhereDomains } from './query-proof-residual.js';
import {
  analyzeListRulePathInvariance,
  buildListRuleFunctionScope,
} from './list-rule-path-proof.js';

export type { QueryConstraints, QueryProofResidual, QueryWhereConstraint };

/** Local proof evidence. These categories do not claim a Firebase decision. */
export interface QueryProofFailure {
  kind: 'unsupported-predicate' | 'unsupported-path' | 'constraints-not-satisfied';
  reason: string;
  residual: QueryProofResidual;
  /** Location of the rejected predicate, which may be inside a helper. */
  predicate?: QueryProofFailure['rule'];
  rule?: {
    line?: number;
    col?: number;
    column?: number;
    file?: string;
    citation?: string;
    expression?: string;
  };
}

export interface QueryProofDiagnostic {
  kind: QueryProofFailure['kind'] | 'residual-denied' | 'no-rule';
  /** Rejected rules, in source order. None were evaluated against stored rows. */
  failures: QueryProofFailure[];
  /** Complete query identity, separate from the conservative proof projection. */
  query?: unknown;
}

/**
 * Separate static list-query proof verdict reported alongside per-document
 * evaluation on `TestResult` / `CaseResult` / `Explanation` (#371).
 */
export interface ListQueryProofReport {
  /** Static list-query proof verdict, separate from per-document `decision`. */
  verdict: 'PROVABLE' | 'UNPROVABLE' | 'NO_RULE';
  /** True when the rules can statically prove every document the query could return is readable. */
  provable: boolean;
  /** Specific proof classification (`'provable'`, `'no-rule'`, or the primary failure kind). */
  kind: 'provable' | 'no-rule' | QueryProofFailure['kind'];
  /** Rules rejected by static query proof, in source order. */
  failures: QueryProofFailure[];
  /** Human-readable explanation when `verdict === 'UNPROVABLE'`. */
  reason?: string;
  /** Structured account of missing/mismatched `where(...)` equalities when `verdict === 'UNPROVABLE'`. */
  residual?: QueryProofResidual;
  /** Narrowing `where(...)` remediation when `verdict === 'UNPROVABLE'` and equalities can discharge the rule. */
  remediation?: string;
  /** Source location and expression of the primary unprovable rule when `verdict === 'UNPROVABLE'`. */
  rule?: EvaluatedRuleInfo;
}

/** Ready-to-run repro for a rejected list query (#371). */
export interface QueryRepro {
  /** Ready-to-run CLI command that simulates the rejected list query. */
  command: string;
  /** Copy-pasteable TestCase / FirestoreCase fixture object for `simulate()`. */
  testCase: {
    description: string;
    expectation: 'ALLOW';
    method: 'list';
    path: string;
    auth: { uid: string; token?: Record<string, unknown> } | null;
    query?: ListQuery;
  };
}

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
      failures: QueryProofFailure[];
      evaluationAst: FirestoreRules;
      syntheticResource: Record<string, unknown>;
    }
  /** Every matching rule depends on per-document data the query's
   *  constraints cannot prove safe — Pyric rejects the whole query.
   *  `residual` is the structured account (missing / mismatched equalities,
   *  or an out-of-scope shape) that the denial site renders remediation from. */
  | { kind: 'unprovable'; failures: QueryProofFailure[]; reason: string; residual: QueryProofResidual; rule?: EvaluatedRuleInfo }
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
  sourceString?: string,
): ListProofVerdict {
  const isAstDefined = ast !== null;
  if (isAstDefined === false) {
    return { kind: 'no-rule' };
  }
  const segments = relPath.split('/').filter((s) => s.length > 0);
  // Like handler.ts, the root match (/databases/{db}/documents) is implicit:
  // resolution starts at its children with every enclosing helper in scope.
  const rootFunctions = [
    ...(ast!.functions ?? []),
    ...(ast!.service.functions ?? []),
    ...ast!.service.match.functions,
  ];
  const matches: MatchResult[] = [];
  for (const child of ast!.service.match.children) {
    matches.push(...collectMatches(child, segments, rootFunctions));
  }
  const isMatchesEmpty = matches.length === 0;
  if (isMatchesEmpty) {
    return { kind: 'no-rule' };
  }

  // OR semantics across allow rules: ANY provable rule makes the query
  // provable. Residual simulation receives ONLY those provable rules, so an
  // unprovable sibling cannot grant from a concrete placeholder document.
  const failures: QueryProofFailure[] = [];
  const provableRules = new Map<AllowRule, AllowRule>();
  let applicableRuleCount = 0;
  for (const match of matches) {
    const functionScope = buildListRuleFunctionScope(match.functions);
    const fnMap = functionScope.functions;
    for (const rule of match.block.allows) {
      const hasListOrRead = rule.operations.some((op) => {
        const isList = op === 'list';
        if (isList) {
          return true;
        }
        const isRead = op === 'read';
        return isRead;
      });
      if (hasListOrRead === false) {
        continue;
      }
      applicableRuleCount++;
      const pathAnalysis = analyzeListRulePathInvariance(
        rule.condition,
        new Set(match.candidateVariables),
        fnMap,
        functionScope.ambiguousNames,
      );
      const isInvariant = pathAnalysis.pathInvariant === true;
      if (isInvariant === false) {
        failures.push({
          kind: 'unsupported-path',
          reason: 'list rule depends on the candidate document path',
          residual: { missing: [], mismatched: [] },
          rule: proofRuleInfo(rule, sourceString),
        });
        continue;
      }
      // `auth.uid` is threaded into the proof so the canonical owner pattern
      // can be discharged by a matching query equality. Residual simulation
      // still evaluates the real auth value against the synthetic resource.
      const result = evaluateQueryProof(rule.condition, constraints, fnMap, auth?.uid);
      const isProvable = result.provable === true;
      if (isProvable) {
        provableRules.set(rule, result.residualCondition ? { ...rule, condition: result.residualCondition } : rule);
      }
      const failure = result.provable ? result.proofFailure : result;
      if (failure) {
        failures.push({
          kind: failure.kind, reason: failure.reason, residual: failure.residual,
          rule: proofRuleInfo(rule, sourceString),
          ...(failure.residual.predicate ? { predicate: proofSourceInfo(
            failure.residual.predicate, failure.residual.predicateLoc ?? rule.loc, sourceString,
          ) } : {}),
        });
      }
    }
  }
  const isAppCountZero = applicableRuleCount === 0;
  if (isAppCountZero) {
    return { kind: 'no-rule' };
  }
  const isProvableEmpty = provableRules.size === 0;
  if (isProvableEmpty) {
    const first = failures[0]!;
    return {
      kind: 'unprovable',
      failures,
      reason: first.reason,
      residual: first.residual,
      ...(first.rule ? { rule: { ...first.rule, verdict: 'deny' as const } } : {}),
    };
  }

  return {
    kind: 'provable',
    failures,
    evaluationAst: projectRules(ast!, provableRules),
    syntheticResource: syntheticResourceFromWheres(constraints),
  };
}

/** Resolve against authored source before assembly removes rejected siblings. */
function proofRuleInfo(rule: AllowRule, source = ''): NonNullable<QueryProofFailure['rule']> {
  return proofSourceInfo(printExpression(rule.condition), rule.loc, source);
}

function proofSourceInfo(expression: string, loc: AllowRule['loc'], source = ''): NonNullable<QueryProofFailure['rule']> {
  if (!loc) return { expression };
  const { line, col, file } = loc;
  const authored = resolveAuthoredSourceLoc(source, line, col, file, expression);
  if (authored) return { ...authored, column: authored.col, expression: authored.expression ?? expression };
  return { line, col, column: col, file: file ?? 'firestore.rules',
    citation: `${file ?? 'firestore.rules'}:${line}:${col}`, expression };
}

// ─── Proof/execution projection ──────────────────────────────────

/** Preserve match paths and helper scopes while removing every rule the
 * static proof did not approve. This keeps residual execution and proof on
 * the exact same set of potentially granting rules. */
function projectRules(ast: FirestoreRules, retained: ReadonlyMap<AllowRule, AllowRule>): FirestoreRules {
  const projectBlock = (block: MatchBlock): MatchBlock => ({
    ...block,
    allows: block.allows.filter((rule) => retained.has(rule)).map(rule => retained.get(rule)!),
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
 * every field the query's intersected `==` / `in` constraints pin to a single
 * scalar value. Fields the query does not pin stay ABSENT, so a rule conjunct
 * reading them errors (→ deny) rather than passing vacuously.
 */
function syntheticResourceFromWheres(constraints: QueryConstraints): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, values] of computeWhereDomains(constraints)) {
    if (values.length === 1) {
      out[field] = values[0];
    }
  }
  return out;
}

// ─── Query shape conversions ─────────────────────────────────────────────

/** Convert a `ListQuery` from a `TestCase` / `FirestoreCase` into `QueryConstraints`. */
export function listQueryToConstraints(query?: ListQuery): QueryConstraints {
  if (!query) return {};
  return {
    ...(query.where !== undefined ? { where: query.where } : {}),
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
    ...(query.offset !== undefined ? { offset: query.offset } : {}),
    ...(query.orderBy !== undefined ? { orderBy: query.orderBy } : {}),
  };
}

/** Convert `QueryConstraints` back to a `ListQuery` when any constraint is present. */
export function listQueryFromConstraints(structured: QueryConstraints): ListQuery | undefined {
  const hasWhere = structured.where !== undefined && structured.where.length > 0;
  if (!hasWhere && structured.limit == null && structured.offset == null && structured.orderBy == null) {
    return undefined;
  }
  return {
    ...(hasWhere
      ? {
          where: structured.where!.map((w) => ({
            field: w.field,
            op: w.op,
            value: Array.isArray(w.value) ? [...w.value] : (w.value as string | number | boolean | null),
          })),
        }
      : {}),
    ...(structured.limit != null ? { limit: structured.limit } : {}),
    ...(structured.offset != null ? { offset: structured.offset } : {}),
    ...(structured.orderBy != null ? { orderBy: structured.orderBy } : {}),
  };
}

// ─── Remediation & Repro rendering ───────────────────────────────────────

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

function quoteCliArg(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Build a ready-to-run repro (CLI command + fixture `TestCase`) from a rejected
 * `list` request so failure-to-regression-test is copy-paste (#371).
 */
export function buildQueryRepro(input: {
  path: string;
  auth: ReadAuth;
  constraints: QueryConstraints;
}): QueryRepro {
  const query = listQueryFromConstraints(input.constraints);
  const auth = input.auth
    ? {
        uid: input.auth.uid,
        ...(input.auth.token && Object.keys(input.auth.token).length > 0 ? { token: input.auth.token } : {}),
      }
    : null;
  const testCase: QueryRepro['testCase'] = {
    description: `list ${input.path}`,
    expectation: 'ALLOW',
    method: 'list',
    path: input.path,
    auth,
    ...(query ? { query } : {}),
  };
  const args = [
    'pyric rules simulate --service firestore --operation list',
    `--path ${quoteCliArg(input.path)}`,
    ...(auth ? [`--uid ${quoteCliArg(auth.uid)}`] : []),
    ...(query ? [`--query '${JSON.stringify(query).replace(/'/g, "'\\''")}'`] : []),
  ];
  return {
    command: args.join(' '),
    testCase,
  };
}

/** Render a human-readable copy-paste repro block for terminal/error output (#371). */
export function renderQueryRepro(input: {
  path: string;
  auth: ReadAuth;
  constraints: QueryConstraints;
}): string {
  const repro = buildQueryRepro(input);
  return [
    'Reproduce with:',
    `  ${repro.command}`,
    `  Fixture case: ${JSON.stringify(repro.testCase)}`,
  ].join('\n');
}
