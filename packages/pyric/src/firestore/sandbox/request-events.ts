/**
 * History — request-event payload builders for the Firestore sandbox
 * engine's traffic log (ADR-0007 mechanical extraction from
 * `local-environment.ts`).
 */
import type { EvaluatedRuleInfo } from 'pyric/rules/internal';
import type { DocumentData } from './local-state.js';
import type { EventProvenance } from '../../sandbox/types/events.js';
import type { Operation } from './writes.js';

// ─── RequestEvent emission (issue #307) ───────────────────────────────

/**
 * Input to {@link LocalEnvironment.emitRequest}. The internal shape the
 * env's emit sites assemble; `buildRequestEvent` converts to the public
 * `RequestEvent` shape consumers see.
 */
export interface EmitRequestInput {
  at: number;
  evalMs: number;
  method: Operation['method'];
  path: string;
  auth: Operation['auth'];
  result: 'allow' | 'deny' | 'unsupported';
  debugMessages: string[];
  /** The deciding rule's verdict + line + sub-expression trace (from
   *  `projectEvaluatedRule`). Surfaced on allow AND deny events (see
   *  `buildRequestEvent`); never on unsupported. */
  evaluatedRule?: EvaluatedRuleInfo;
  resourceData?: DocumentData;
  resourceBefore?: { data: DocumentData | null; exists: boolean };
  resourceAfter?: { data: DocumentData | null; exists: boolean };
  origin: 'user' | 'listener' | 'transaction' | 'batch';
  groupId?: string;
  triggeredBy?: { method: string; path: string };
  detail?: { admin?: boolean } & Record<string, unknown>;
  provenance?: EventProvenance;
}

let _requestEventSeq = 0;

export function nextRequestEventId(): string {
  // Monotonic + random tail. Stable for the lifetime of the JS process;
  // doesn't try to be cryptographically unique because consumers use it
  // as a React list key, not a security token.
  _requestEventSeq = (_requestEventSeq + 1) >>> 0;
  return `req-${_requestEventSeq.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Parse `Rule #N (ops...) → ALLOW/deny` lines out of the simulator's
 * debug messages. The simulator emits one such line per evaluated rule
 * in the matched match block (see `evaluateRules` in
 * `pyric/rules/handler.ts`). For allowed outcomes
 * the last `→ ALLOW` rule wins; for denials we surface the first rule
 * that even tried to match this op-set.
 */
function parseMatchedRule(
  debugMessages: string[],
  result: 'allow' | 'deny' | 'unsupported',
): { ruleIndex: number; operations: string[] } | undefined {
  const wantAllow = result === 'allow';
  let last: { ruleIndex: number; operations: string[] } | undefined;
  for (const msg of debugMessages) {
    const m = /^Rule #(\d+) \(([^)]+)\) → (ALLOW|deny|unsupported)/.exec(msg);
    if (!m) continue;
    const candidate = {
      ruleIndex: Number(m[1]),
      operations: m[2].split(',').map((s) => s.trim()),
    };
    if (wantAllow && m[3] === 'ALLOW') return candidate;
    last = candidate;
  }
  return last;
}

export function buildRequestEvent(input: EmitRequestInput): import('../../sandbox/types/events.js').RequestEvent {
  const out: import('../../sandbox/types/events.js').RequestEvent = {
    kind: 'request',
    id: nextRequestEventId(),
    at: input.at,
    evalMs: input.evalMs,
    method: input.method,
    path: input.path,
    auth: input.auth ? { uid: input.auth.uid, ...(input.auth.token ? { token: input.auth.token } : {}) } : null,
    result: input.result,
    reasons: input.debugMessages,
    origin: input.origin,
  };
  if (input.resourceData !== undefined) {
    out.request = { resourceData: input.resourceData };
  }
  if (input.resourceBefore !== undefined) {
    out.resourceBefore = input.resourceBefore;
  }
  if (input.resourceAfter !== undefined) {
    out.resourceAfter = input.resourceAfter;
  }
  const matched = parseMatchedRule(input.debugMessages, input.result);
  if (matched) out.matchedRule = matched;
  // The structured deciding-rule projection (verdict + line + expression
  // trace) rides alongside the flat `reasons` on rules-evaluated results —
  // the allowing rule on an allow, the denying rule on a deny. Unsupported
  // results have no deciding rule (the simulator abstained).
  if (input.result !== 'unsupported' && input.evaluatedRule) {
    out.evaluatedRule = input.evaluatedRule;
  }
  if (input.groupId !== undefined) {
    out.groupId = input.groupId;
    // Disambiguates 'origin' for consumers that want the group kind
    // without re-parsing the prefix.
    if (input.origin === 'batch') out.groupKind = 'batch';
    else if (input.origin === 'transaction') out.groupKind = 'transaction';
  }
  if (input.triggeredBy !== undefined) out.triggeredBy = input.triggeredBy;
  if (input.detail !== undefined) out.detail = input.detail;
  if (input.provenance !== undefined) Object.assign(out, input.provenance);
  return out;
}
