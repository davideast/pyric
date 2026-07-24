/**
 * Rules-failure debugging: the pure view-model (Pyric Studio F4).
 *
 * Prose spec (what this page shows per service, grounded in each service's
 * mechanical rules tooling, and exactly where a capability is gated off) lives
 * in the colocated `SPEC.md` — read that first.
 *
 * Everything here is a PURE function over the unified event stream
 * ({@link SandboxEvent}), no React, no worker, no DOM. The UI (`RulesDebug.tsx`)
 * renders these shapes; the re-run actions (`rerun.ts`) consume a {@link Denial}.
 * Factoring the denial→rule→context derivation out as data makes it unit-testable
 * without a browser (see `rules-debug.test.ts`).
 */

import type {
  AuthState,
  RequestEvent,
  SandboxEvent,
  SandboxOperationEvent,
} from 'pyric/sandbox';
import { toOperationRecord } from 'pyric/sandbox';
import type { EvaluatedRuleInfo, ExprTraceEntry } from 'pyric/rules/internal';

type DeniedSandboxEvent = RequestEvent | SandboxOperationEvent;

/** The rule-engine verdict a service's mechanical simulator/enforcer stamped on
 *  the operation event. Mirrors {@link SandboxOperationEvent.rules} verbatim (do
 *  not invent a parallel shape). Present on RTDB denials today; Firestore keeps
 *  its per-rule trace on `reasons`/`matchedRule`; Storage emits its evaluator
 *  reasons without a Firestore-style expression trace. */
export type RuleVerdict = NonNullable<SandboxOperationEvent['rules']>;

/**
 * A single RULES-EVALUATED operation, projected from a request event. Despite
 * the historical name (the surface began as denial-only), this now covers BOTH
 * verdicts — `result` says which — so the rules inspector can open allowed ops
 * too. `selectDenials` still projects only denials; `selectRuleEvaluations`
 * projects both.
 */
export interface Denial {
  /** The originating request event's id (stable React key + correlation). */
  id: string;
  /** Wall-clock at op start (ms since epoch). */
  at: number;
  /** The rules verdict for the op. `'unsupported'` = the simulator abstained. */
  result: 'allow' | 'deny' | 'unsupported';
  /** The operation the rule evaluated. */
  method: RequestEvent['method'] | string;
  /** Service whose rules evaluated the operation. */
  service: 'firestore' | 'auth' | 'storage' | 'rtdb' | string;
  /** Full resource path (e.g. `notes/abc`). */
  path: string;
  /** The `request.auth` identity the rule evaluated under (`null` = anonymous). */
  auth: AuthState;
  /** The rule that denied, parsed from the simulator trace (Firestore). Absent
   *  when no rule even tried to match (implicit deny: no `allow` at the path). */
  matchedRule?: { ruleIndex: number; operations: string[] };
  /** The service rules engine's structured verdict (RTDB `.write`/`.validate`
   *  node, matched path, bindings, reason). Absent for Firestore (whose trace
   *  lives in `reasons`/`matchedRule`) and for any denial that arrived on a
   *  legacy `RequestEvent`. */
  rules?: RuleVerdict;
  /** Raw simulator/enforcer trace lines (Firestore `Rule #N (ops) → deny`;
   *  RTDB `${path} write DENY: …`; Storage `match /… verb: condition false`). */
  reasons: string[];
  /** Proposed write payload (create/update/set). Absent on reads + delete. */
  resourceData?: unknown;
  /** Existing doc state the rule saw (`null`/`exists:false` ⇒ absent doc). */
  resourceBefore?: { data: unknown; exists: boolean };
  /** The DECIDING rule's verdict + 1-indexed source line + condition text +
   *  sub-expression evaluation trace, threaded from the Firestore simulator's
   *  structured `RuleEvaluation` (`RequestEvent.evaluatedRule`): the allowing
   *  rule on an allow, the denying rule on a deny. Drives the ✓/✗ line marker
   *  in the rules editor views and the "show the work" step-through. Absent on
   *  an implicit deny (no rule evaluated), a simulator-error deny, and for
   *  RTDB/Storage (which don't emit a Firestore sub-expression trace). */
  evaluatedRule?: EvaluatedRuleInfo;
  /** Where the op came from (user op, listener re-eval, batch, transaction). */
  origin: RequestEvent['origin'] | SandboxOperationEvent['origin'];
  /** `'unsupported'` denials (simulator hit an unmodelled feature) are flagged
   *  so the UI can distinguish them from a genuine rule rejection. */
  unsupported: boolean;
}

/** Type guard: a request event the rules engine rejected (deny or unsupported). */
function isDeniedRequest(e: SandboxEvent): e is DeniedSandboxEvent {
  return (
    (e.kind === 'request' || e.kind === 'operation') &&
    (e.result === 'deny' || e.result === 'unsupported')
  );
}

/** Type guard: a request event the rules engine EVALUATED — allow, deny, or
 *  unsupported. Excludes non-rule results (not-applicable, error) so the rules
 *  inspector only ever opens ops that actually went through a rules engine. */
function isRulesEvaluatedRequest(e: SandboxEvent): e is DeniedSandboxEvent {
  return toOperationRecord(e)?.rules.kind === 'evaluated';
}

function serviceOf(e: DeniedSandboxEvent): string {
  return 'service' in e && typeof e.service === 'string' ? e.service : 'firestore';
}

function requestDataOf(e: DeniedSandboxEvent): unknown {
  const request = e.request;
  if (!request) return undefined;
  if ('resourceData' in request && request.resourceData !== undefined) return request.resourceData;
  if ('data' in request) return request.data;
  return undefined;
}

/**
 * Project the unified event stream down to the denied operations, newest first.
 *
 * Pass `sandbox.history()` or an accumulated `onEvent` buffer. Listener re-evals
 * that denied (`origin:'listener'`) are included: a watch that started erroring
 * after a rules change is exactly the kind of failure F4 exists to explain.
 */
export function selectDenials(events: readonly SandboxEvent[]): Denial[] {
  const out: Denial[] = [];
  for (const e of events) {
    if (!isDeniedRequest(e)) continue;
    out.push(toDenial(e));
  }
  // Newest first: the most recent failure is the one you're debugging.
  return out.sort((a, b) => b.at - a.at);
}

/**
 * Project the unified event stream down to ALL rules-evaluated operations
 * (allow AND deny/unsupported), newest first — the rules inspector's feed.
 * Same projection as {@link selectDenials} without the deny-only filter.
 */
export function selectRuleEvaluations(events: readonly SandboxEvent[]): Denial[] {
  const out: Denial[] = [];
  for (const e of events) {
    if (!isRulesEvaluatedRequest(e)) continue;
    out.push(toDenial(e));
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Project one rules-evaluated request event to a {@link Denial}. */
export function toDenial(e: DeniedSandboxEvent): Denial {
  const d: Denial = {
    id: e.id,
    at: e.at,
    result:
      e.result === 'allow' ? 'allow' : e.result === 'unsupported' ? 'unsupported' : 'deny',
    method: e.method,
    service: serviceOf(e),
    path: e.path ?? '(service)',
    auth: e.auth,
    reasons: e.reasons ?? [],
    origin: e.origin,
    unsupported: e.result === 'unsupported',
  };
  if ('matchedRule' in e && e.matchedRule) d.matchedRule = e.matchedRule;
  if ('evaluatedRule' in e && e.evaluatedRule) d.evaluatedRule = e.evaluatedRule;
  if ('rules' in e && e.rules) d.rules = e.rules;
  const requestData = requestDataOf(e);
  if (requestData !== undefined) d.resourceData = requestData;
  if (e.resourceBefore) {
    d.resourceBefore = {
      data: e.resourceBefore.data,
      exists: e.resourceBefore.exists,
    };
  }
  return d;
}

// ─── Per-service explanation ────────────────────────────────────────────────

/** Which mechanical rules engine produced a denial. */
export type RuleEngine = 'firestore' | 'rtdb' | 'storage';

/** For RTDB, WHICH rule phase denied — the `.read`/`.write` gate, or a
 *  non-cascading `.validate` on the proposed value. */
export type RulePhase = 'read' | 'write' | 'validate';

/**
 * A human-readable explanation of *why* a denial fired, grounded in the
 * emitting service's mechanical rules engine.
 *
 * `headline` is a one-line summary; the per-service fields carry the tool-grounded
 * detail the UI renders:
 *   - `engine`     which rules engine decided (firestore/rtdb/storage).
 *   - `ruleNode`   the denying node in that engine's own terms: Firestore
 *                  `Rule #N (ops)`, RTDB `${matchedPath} .write|.validate|.read`,
 *                  Storage `match /… verb`. Absent on an implicit deny.
 *   - `ruleExpression` the raw rule text that evaluated false (RTDB `matchedRule`).
 *   - `phase`      RTDB only — `.read`/`.write` gate vs `.validate`.
 *   - `bindings`   RTDB path-variable bindings ($roomId → r1).
 *   - `ruleLines`  Firestore per-rule trace entries (`Rule #N (ops) → deny`).
 *   - `otherLines` remaining trace/context lines (get() lookups, notes).
 *   - `implicitDeny` no rule matched at all — the "you forgot an `allow`" case,
 *                  service-aware (Firestore: no `matchedRule`; RTDB:
 *                  `NO_MATCHING_RULE` / no `matchedPath`; Storage: `no rule
 *                  matches`).
 */
export interface RuleExplanation {
  headline: string;
  engine: RuleEngine;
  ruleNode?: string;
  ruleExpression?: string;
  phase?: RulePhase;
  bindings?: Record<string, string>;
  ruleLines: string[];
  otherLines: string[];
  implicitDeny: boolean;
  /** True when the event is marked `allow` but carries NO rules evaluation at
   *  all (no matchedRule, no engine verdict, no evaluatedRule, no per-rule
   *  trace lines). That means rules likely never ran — an admin-bypass op from
   *  a worker that didn't stamp its lens, or a mislabel. The UI must NOT
   *  render a matched rule / ✓ marker / trace / re-runs for it; it says so
   *  explicitly instead. */
  noEvaluation?: boolean;
}

const RULE_LINE = /^Rule #(\d+) \(([^)]+)\) → (ALLOW|deny|unsupported)/;

/** Normalise a denial's service to one of the three rules engines. Unknown
 *  services (or `auth`, which has no security rules) fall back to firestore-style
 *  presentation, which is trace-only and safe. */
function engineOf(denial: Denial): RuleEngine {
  const e = denial.rules?.engine ?? denial.service;
  return e === 'rtdb' || e === 'storage' ? e : 'firestore';
}

/** RTDB rule phase for a denial: a `.validate` failure (from the mechanical
 *  `reason`) beats the method-derived read/write gate. */
function rtdbPhase(denial: Denial): RulePhase {
  if (denial.rules?.reason === 'Validation rule evaluated to false') return 'validate';
  const m = denial.method;
  return m === 'get' || m === 'list' || m === 'listen' ? 'read' : 'write';
}

export function explainDenial(denial: Denial): RuleExplanation {
  const engine = engineOf(denial);
  const ruleLines = denial.reasons.filter((l) => RULE_LINE.test(l));
  const otherLines = denial.reasons.filter((l) => !RULE_LINE.test(l));

  if (denial.unsupported) {
    return {
      headline: `The simulator hit an unmodelled rules feature evaluating ${denial.method} ${denial.path}.`,
      engine,
      ruleLines,
      otherLines,
      implicitDeny: false,
    };
  }

  // An ALLOWED op: the deciding rule GRANTED access. Explained generically for
  // any engine — the interesting per-engine detail (rule node, expression,
  // bindings) is still projected below for Firestore/RTDB from the same fields.
  if (denial.result === 'allow') {
    if (engine === 'firestore' && denial.matchedRule) {
      const r = denial.matchedRule;
      const ruleNode = `Rule #${r.ruleIndex} (${r.operations.join(', ')})`;
      return {
        headline: `${ruleNode} allowed ${denial.method} on ${denial.path}.`,
        engine,
        ruleNode,
        ruleLines,
        otherLines,
        implicitDeny: false,
      };
    }
    // Honesty guard: `result: 'allow'` with NO recorded rules evaluation at
    // all. Rules likely never ran (an admin-bypass op whose lens wasn't
    // stamped by an older worker, or a mislabel) — say so rather than render
    // a "Rules allowed …" claim with an undefined matched rule.
    const noEvaluation =
      !denial.matchedRule &&
      !denial.rules &&
      !denial.evaluatedRule &&
      ruleLines.length === 0;
    if (noEvaluation) {
      return {
        headline: `This ${denial.method} on ${denial.path} succeeded, but no rules evaluation was recorded for it — rules likely never ran (an admin/bypass operation from a worker that didn't stamp its lens, or a pre-provenance event).`,
        engine,
        ruleLines,
        otherLines,
        implicitDeny: false,
        noEvaluation: true,
      };
    }
    return {
      headline: `Rules allowed ${denial.method} on ${denial.path}.`,
      engine,
      ...(denial.rules?.matchedRule ? { ruleExpression: denial.rules.matchedRule } : {}),
      ruleLines,
      otherLines,
      implicitDeny: false,
    };
  }

  if (engine === 'rtdb') return explainRtdb(denial, ruleLines, otherLines);
  if (engine === 'storage') return explainStorage(denial, ruleLines, otherLines);
  return explainFirestore(denial, ruleLines, otherLines);
}

/** Firestore: grounded in the simulator's `Rule #N` trace + `matchedRule`. */
function explainFirestore(
  denial: Denial,
  ruleLines: string[],
  otherLines: string[],
): RuleExplanation {
  const implicitDeny = !denial.matchedRule;
  let headline: string;
  let ruleNode: string | undefined;
  if (implicitDeny) {
    headline = `No rule allowed ${denial.method} on ${denial.path}: implicit deny (no matching \`allow\`).`;
  } else {
    const r = denial.matchedRule!;
    ruleNode = `Rule #${r.ruleIndex} (${r.operations.join(', ')})`;
    headline = `${ruleNode} denied ${denial.method} on ${denial.path}.`;
  }
  return { headline, engine: 'firestore', ruleNode, ruleLines, otherLines, implicitDeny };
}

/** RTDB: grounded in `SimulateHandler`'s verdict — the `.write`/`.validate` node
 *  at `matchedPath`, its raw expression, and the path-variable bindings. */
function explainRtdb(
  denial: Denial,
  ruleLines: string[],
  otherLines: string[],
): RuleExplanation {
  const rules = denial.rules;
  const phase = rtdbPhase(denial);
  const implicitDeny = !rules?.matchedPath || rules?.errorCode === 'NO_MATCHING_RULE';
  const bindings =
    rules?.pathVariableBindings && Object.keys(rules.pathVariableBindings).length > 0
      ? rules.pathVariableBindings
      : undefined;

  let headline: string;
  let ruleNode: string | undefined;
  if (implicitDeny) {
    headline = `No \`.${phase}\` rule granted ${denial.method} on ${denial.path}: RTDB implicit deny (no rule matched).`;
  } else if (phase === 'validate') {
    ruleNode = `${rules!.matchedPath} .validate`;
    headline = `The \`.validate\` rule at \`${rules!.matchedPath}\` rejected the proposed value for ${denial.method} ${denial.path}.`;
  } else {
    ruleNode = `${rules!.matchedPath} .${phase}`;
    headline = `The \`.${phase}\` rule at \`${rules!.matchedPath}\` evaluated false for ${denial.method} ${denial.path}.`;
  }

  return {
    headline,
    engine: 'rtdb',
    ruleNode,
    ruleExpression: rules?.matchedRule,
    phase,
    bindings,
    ruleLines,
    otherLines,
    implicitDeny,
  };
}

/** Storage: grounded in `evaluateStorageRules`' reasons — the `match` block whose
 *  `allow` condition was false, or the no-rule-matched implicit deny. */
function explainStorage(
  denial: Denial,
  ruleLines: string[],
  otherLines: string[],
): RuleExplanation {
  const matchLine = denial.reasons.find((l) => /^match\s/.test(l));
  const noRule = denial.reasons.some((l) => /^no rule matches/.test(l));
  const implicitDeny = noRule || !matchLine;

  const headline = implicitDeny
    ? `No \`match\` block allowed ${denial.method} on ${denial.path}: Storage implicit deny (no rule matched).`
    : `A \`match\` block condition evaluated false for ${denial.method} on ${denial.path}.`;

  return {
    headline,
    engine: 'storage',
    ruleNode: implicitDeny ? undefined : matchLine,
    ruleLines,
    otherLines,
    implicitDeny,
  };
}

/**
 * Severity ramp for a denial, mapping to the `--color-severity-*` token roles.
 * `unsupported` is the loudest (the sandbox couldn't even decide); a genuine
 * rule rejection is high; an implicit deny is medium (usually a missing rule,
 * not a security event). Listener-origin denials are low-key context.
 */
export type DenialSeverity = 'low' | 'medium' | 'high';

export function denialSeverity(denial: Denial): DenialSeverity {
  if (denial.result === 'allow') return 'low';
  if (denial.unsupported) return 'high';
  if (denial.origin === 'listener') return 'low';
  if (explainDenial(denial).implicitDeny) return 'medium';
  return 'high';
}

// ─── "Show the work": the sub-expression evaluation trace ───────────────────

/**
 * One node of the denying rule's evaluation, projected from an
 * {@link ExprTraceEntry} for display. `outcome` classifies the evaluated value
 * so the UI can mark the branch that was false (the ✗) without re-deriving it:
 *   - `true` / `false`  the sub-expression evaluated to that boolean;
 *   - `skipped`         a `&&`/`||` operand short-circuited (not evaluated);
 *   - `error`           the sub-expression threw;
 *   - `value`           a non-boolean value (an operand feeding a comparison).
 * `depth` and `children` reconstruct the AST tree from the flat trace so the
 * view can indent operands under their operator. Pure — unit-tested.
 */
export interface TraceStep {
  source: string;
  outcome: 'true' | 'false' | 'skipped' | 'error' | 'value';
  value?: unknown;
  error?: string;
  /** Set when this node recorded a `let name = …` binding inside a function. */
  letBinding?: string;
  /** The enclosing user-defined function this node was inlined from, if any. */
  inlinedFrom?: string;
  depth: number;
  children: TraceStep[];
}

function classifyOutcome(e: ExprTraceEntry): TraceStep['outcome'] {
  if (e.skipped) return 'skipped';
  if (e.error !== undefined) return 'error';
  if (e.value === true) return 'true';
  if (e.value === false) return 'false';
  return 'value';
}

/**
 * Project a denying rule's flat {@link ExprTraceEntry} array into a tree of
 * {@link TraceStep}s (via each entry's `parent` index). Roots are the
 * top-level expressions of the condition. Returns `[]` when the denial carries
 * no expression trace (implicit deny, simulator-error deny, RTDB/Storage).
 */
export function projectTraceSteps(denial: Denial): TraceStep[] {
  const entries = denial.evaluatedRule?.expressionTrace;
  if (!entries || entries.length === 0) return [];
  const nodes: TraceStep[] = entries.map((e) => ({
    source: e.source,
    outcome: classifyOutcome(e),
    ...(e.value !== undefined ? { value: e.value } : {}),
    ...(e.error !== undefined ? { error: e.error } : {}),
    ...(e.letBinding ? { letBinding: e.letBinding.name } : {}),
    ...(e.inlinedFrom ? { inlinedFrom: e.inlinedFrom.name } : {}),
    depth: 0,
    children: [],
  }));
  const roots: TraceStep[] = [];
  entries.forEach((e, i) => {
    if (e.parent === null || e.parent === undefined || !nodes[e.parent]) {
      roots.push(nodes[i]);
    } else {
      nodes[i].depth = nodes[e.parent].depth + 1;
      nodes[e.parent].children.push(nodes[i]);
    }
  });
  return roots;
}

// ─── "What the rule saw": inspectable request/resource variables ────────────

/** A rules variable the UI can render as a read-only inspectable tree. When a
 *  value genuinely wasn't captured for a denial, `present` is false so the UI
 *  shows it as honestly absent rather than as an empty object. */
export interface RuleVariable {
  /** Dotted rules identifier, e.g. `request.auth`, `resource.data`. */
  name: string;
  present: boolean;
  value: unknown;
  /** One-line note shown when absent (why the rule didn't see it). */
  absentNote?: string;
}

/**
 * The variables the denying rule evaluated against, in rules terms
 * (`request.auth`, `request.method`, `request.path`, `request.resource.data`,
 * `resource`), projected from the denial's captured context. Read-only — this
 * is what the rule SAW, not an editor. Absent values are reported honestly.
 */
export function ruleVariables(denial: Denial): RuleVariable[] {
  const vars: RuleVariable[] = [
    {
      name: 'request.auth',
      present: denial.auth !== null,
      value: denial.auth,
      ...(denial.auth === null
        ? { absentNote: 'request.auth was null — the request was unauthenticated.' }
        : {}),
    },
    { name: 'request.method', present: true, value: denial.method },
    { name: 'request.path', present: true, value: denial.path },
  ];
  const isRead = denial.method === 'get' || denial.method === 'list' || denial.method === 'listen';
  vars.push({
    name: 'request.resource.data',
    present: denial.resourceData !== undefined,
    value: denial.resourceData ?? null,
    ...(denial.resourceData === undefined
      ? {
          absentNote: isRead
            ? 'A read carries no proposed write, so request.resource.data is absent.'
            : 'No proposed write payload was captured for this denial.',
        }
      : {}),
  });
  vars.push({
    name: 'resource',
    present: denial.resourceBefore !== undefined,
    value: denial.resourceBefore
      ? { data: denial.resourceBefore.data, exists: denial.resourceBefore.exists }
      : null,
    ...(denial.resourceBefore === undefined
      ? { absentNote: 'The rule evaluated no existing document (e.g. a list/query, or the doc did not exist).' }
      : {}),
  });
  return vars;
}
