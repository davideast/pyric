import { isQueryProofUnsupported } from './query-proof.js';
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

import { DEFAULT_FIRESTORE_DATABASE } from 'pyric/firestore/internal';
import type {
  AuthState,
  RequestEvent,
  SandboxEvent,
  SandboxListenerEvent,
  SandboxOperationEvent,
} from 'pyric/sandbox';
import { toOperationRecord } from 'pyric/sandbox';
import type { EvaluatedRuleInfo } from 'pyric/rules/internal';
import { explainRtdb, explainRtdbAllow } from './rtdb-explanation.js';

export { rtdbRuleLine } from './rtdb-explanation.js';
export {
  projectRtdbTrace,
  projectTraceSteps,
  ruleVariables,
  type RtdbTraceRow,
  type RuleVariable,
  type TraceStep,
} from './trace-projection.js';

/** Canonical display name of the Firestore ruleset for `database` (`firestore.rules` for `(default)`). */
export function firestoreRulesetLabel(database?: string): string {
  if (database === undefined || database === '' || database === DEFAULT_FIRESTORE_DATABASE) {
    return 'firestore.rules';
  }
  return `firestore:${database} ruleset`;
}

type DeniedSandboxEvent = RequestEvent | SandboxOperationEvent | SandboxListenerEvent;

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
  /** Non-default Cloud Firestore database id when the request targeted a named database. */
  database?: string;
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
  /** Proposed write payload (create/update/set). Absent on reads + delete.
   *  An update's payload is the fields it writes, as nested maps. */
  resourceData?: unknown;
  /** An update's field paths as segment vectors; a segment may contain `.`. */
  updateMask?: string[][];
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
  queryProof?: RequestEvent['queryProof'];
  /** Where the op came from (user op, listener re-eval, batch, transaction). */
  origin: RequestEvent['origin'] | SandboxOperationEvent['origin'];
  /** `'unsupported'` denials (simulator hit an unmodelled feature) are flagged
   *  so the UI can distinguish them from a genuine rule rejection. */
  unsupported: boolean;
}

/** Type guard: a request event the rules engine rejected (deny or unsupported). */
function isDeniedRequest(e: SandboxEvent): e is DeniedSandboxEvent {
  if (e.kind === 'request' || e.kind === 'operation') {
    return e.result === 'deny' || e.result === 'unsupported';
  }
  if (e.kind === 'listener') {
    if (e.phase === 'errored') {
      if (e.result === 'deny' || e.result === 'unsupported') {
        return true;
      }
      if (e.error?.code === 'PERMISSION_DENIED') {
        return true;
      }
    }
  }
  return false;
}

/** Type guard: a request event the rules engine EVALUATED — allow, deny, or
 *  unsupported. Excludes non-rule results (not-applicable, error) so the rules
 *  inspector only ever opens ops that actually went through a rules engine. */
function isRulesEvaluatedRequest(e: SandboxEvent): e is DeniedSandboxEvent {
  if (e.kind === 'listener') {
    if (e.phase === 'errored') {
      if (e.result === 'deny' || e.result === 'unsupported' || e.result === 'allow') {
        return true;
      }
      if (e.error?.code === 'PERMISSION_DENIED') {
        return true;
      }
    }
    return false;
  }
  const record = toOperationRecord(e);
  if (!record) {
    return false;
  }
  return record.rules.kind === 'evaluated';
}

function serviceOf(e: DeniedSandboxEvent): string {
  if ('service' in e) {
    if (typeof e.service === 'string') {
      return e.service;
    }
  }
  return 'firestore';
}

function requestDataOf(e: DeniedSandboxEvent): unknown {
  if (!('request' in e)) {
    return undefined;
  }
  const request = e.request;
  if (!request) return undefined;
  if ('resourceData' in request && request.resourceData !== undefined) return request.resourceData;
  if ('data' in request) return request.data;
  return undefined;
}

function updateMaskOf(e: DeniedSandboxEvent): string[][] | undefined {
  if (!('request' in e) || !e.request) return undefined;
  const request = e.request as { updateMask?: unknown };
  const mask = request.updateMask;
  const isMask = Array.isArray(mask)
    && mask.every((path) => Array.isArray(path) && path.every((segment) => typeof segment === 'string'));
  return isMask ? (mask as string[][]) : undefined;
}

function enrichListenerDenials(denials: Denial[], events: readonly SandboxEvent[]): Denial[] {
  const out: Denial[] = [];
  for (const d of denials) {
    if (d.origin === 'listener') {
      if (!d.rules) {
        let matchedOp: SandboxOperationEvent | undefined = undefined;
        for (const e of events) {
          if (e.kind === 'operation') {
            if (e.method === 'listen' && e.path === d.path) {
              if (e.rules) {
                matchedOp = e;
                break;
              }
            }
          }
        }
        if (matchedOp) {
          if (matchedOp.rules) {
            d.rules = matchedOp.rules;
          }
          if (matchedOp.reasons) {
            if (d.reasons.length === 0) {
              d.reasons = matchedOp.reasons;
            }
          }
        }
      }
    }
    out.push(d);
  }
  return out;
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
  const enriched = enrichListenerDenials(out, events);
  return enriched.sort((a, b) => b.at - a.at);
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
  const enriched = enrichListenerDenials(out, events);
  return enriched.sort((a, b) => b.at - a.at);
}

/** Project one rules-evaluated request event to a {@link Denial}. */
export function toDenial(e: DeniedSandboxEvent): Denial {
  let methodVal = 'listen';
  let pathVal = '(service)';
  let originVal: Denial['origin'] = 'listener';
  if (e.kind === 'request' || e.kind === 'operation') {
    methodVal = e.method;
    if (e.path !== undefined) {
      pathVal = e.path;
    }
    originVal = e.origin;
  } else if (e.kind === 'listener') {
    methodVal = 'listen';
    if (e.target.path !== undefined) {
      pathVal = e.target.path;
    }
    originVal = 'listener';
  }

  let resultVal: 'allow' | 'deny' | 'unsupported' = 'deny';
  if (e.result === 'allow') {
    resultVal = 'allow';
  } else if (e.result === 'unsupported') {
    resultVal = 'unsupported';
  }

  const d: Denial = {
    id: e.id,
    at: e.at,
    result: resultVal,
    method: methodVal,
    service: serviceOf(e),
    path: pathVal,
    auth: e.auth,
    reasons: e.reasons ?? [],
    origin: originVal,
    unsupported: resultVal === 'unsupported',
  };
  if ('matchedRule' in e && e.matchedRule) d.matchedRule = e.matchedRule;
  const rawDb = (e as { database?: unknown }).database;
  if (typeof rawDb === 'string' && rawDb.length > 0 && rawDb !== DEFAULT_FIRESTORE_DATABASE) {
    d.database = rawDb;
  }
  if ('evaluatedRule' in e && e.evaluatedRule) d.evaluatedRule = e.evaluatedRule;
  if ('queryProof' in e && e.queryProof) d.queryProof = e.queryProof;
  if ('rules' in e && e.rules) d.rules = e.rules;
  const requestData = requestDataOf(e);
  if (requestData !== undefined) d.resourceData = requestData;
  const updateMask = updateMaskOf(e);
  if (updateMask !== undefined) d.updateMask = updateMask;
  if ('resourceBefore' in e && e.resourceBefore) {
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
  database?: string;
  ruleset?: string;
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

/** Static attribution is separate from the rule that actually evaluated. */
export function queryProofFailure(denial: Denial): NonNullable<RequestEvent['queryProof']>['failures'][number] | undefined {
  if (denial.result === 'allow') return undefined;
  return denial.queryProof?.failures.find(failure => failure.kind === denial.queryProof?.kind);
}

export function explainDenial(denial: Denial): RuleExplanation {
  const engine = engineOf(denial);
  const ruleLines = denial.reasons.filter((l) => RULE_LINE.test(l));
  const otherLines = denial.reasons.filter((l) => !RULE_LINE.test(l));

  const proofFailure = queryProofFailure(denial);
  if (proofFailure) {
    const unsupported = isQueryProofUnsupported(denial);
    return {
      headline: unsupported
        ? `Query proof unsupported: Pyric could not prove ${denial.method} ${denial.path} safe. This does not establish Firebase's decision.`
        : `The query constraints do not satisfy the list rule for ${denial.path}.`,
      engine,
      ruleNode: proofFailure.rule?.citation ?? 'list rule',
      ruleExpression: proofFailure.rule?.expression,
      ruleLines,
      otherLines,
      implicitDeny: false,
    };
  }

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
      let headline = `${ruleNode} allowed ${denial.method} on ${denial.path}.`;
      const allowOut: RuleExplanation = {
        headline,
        engine,
        ruleNode,
        ruleLines,
        otherLines,
        implicitDeny: false,
      };
      if (denial.database !== undefined) {
        const ruleset = firestoreRulesetLabel(denial.database);
        allowOut.database = denial.database;
        allowOut.ruleset = ruleset;
        allowOut.headline = `${ruleNode} in ${ruleset} allowed ${denial.method} on ${denial.path} in database "${denial.database}".`;
      }
      return allowOut;
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
    if (engine === 'rtdb' && denial.rules) return explainRtdbAllow(denial, ruleLines, otherLines);
    const genericAllow: RuleExplanation = {
      headline: `Rules allowed ${denial.method} on ${denial.path}.`,
      engine,
      ruleLines,
      otherLines,
      implicitDeny: false,
    };
    if (denial.rules?.matchedRule) {
      genericAllow.ruleExpression = denial.rules.matchedRule;
    }
    return genericAllow;
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
  let dbContext = '';
  if (denial.database !== undefined) {
    dbContext = ` in database "${denial.database}" (${firestoreRulesetLabel(denial.database)})`;
  }
  if (implicitDeny) {
    headline = `No rule allowed ${denial.method} on ${denial.path}${dbContext}: implicit deny (no matching \`allow\`).`;
  } else {
    const r = denial.matchedRule!;
    ruleNode = `Rule #${r.ruleIndex} (${r.operations.join(', ')})`;
    headline = `${ruleNode} denied ${denial.method} on ${denial.path}${dbContext}.`;
  }
  const out: RuleExplanation = {
    headline,
    engine: 'firestore',
    ruleNode,
    ruleLines,
    otherLines,
    implicitDeny,
  };
  if (denial.database !== undefined) {
    out.database = denial.database;
    out.ruleset = firestoreRulesetLabel(denial.database);
  }
  return out;
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
