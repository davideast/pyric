/**
 * Traffic verdicts (specs/traffic.md, MVP slice): derive each row's rules
 * verdict from fields the event stream ALREADY carries — no pipeline or
 * simulator work.
 *
 *   allow  rules evaluated and allowed
 *   deny   rules evaluated and denied
 *   proof-unsupported  local rejection with incomplete static proof
 *   bypassed  rules BYPASSED (currently by an admin lens)
 *   null   Rules not evaluated (no rules / unsupported / runtime op) — blank cell
 *
 * PURE: mapping + filtering + identity formatting only; the surface renders.
 */

import { isQueryProofUnsupported } from '../rules-debug/query-proof.js';
import type { EventCaller, ObservedProduction, RequestEvent, OperationContext, RulesDisposition } from 'pyric/sandbox';
import type { TrafficEvent } from '@pyric/ui/traffic';
import { observedMethod, productionVerdict } from 'pyric/sandbox/internal';
import type { ExprTraceEntry } from 'pyric/rules/internal';
import type { Denial } from '../rules-debug/index.js';
import type { CommandTarget } from '../home/command.js';

/** A traffic event as Studio's adapter emits it: the library shape plus the
 * canonical context and Rules disposition normalized by the sandbox recorder.
 * Studio source is stamped mechanically at the issuing call site, never
 * inferred from the operation shape. */
export type StudioTrafficEvent = TrafficEvent & {
  queryProof?: RequestEvent['queryProof'];
  operationContext: OperationContext;
  rulesDisposition: RulesDisposition;
  /** The connection the host received the op from; absent when no host stamped one. */
  caller?: EventCaller;
  /** What production answered, when production served the op and pyric only observed it. */
  production?: ObservedProduction;
};

/** Was this op issued by Pyric Studio itself (data viewers/editors, the
 * typeahead index, seed actions)? Source is independent of the auth lens. */
export function isStudioTraffic(event: Pick<StudioTrafficEvent, 'operationContext'>): boolean {
  return event.operationContext.source.kind === 'studio';
}

/** Drop Studio-issued events when `hide` is on (pure; `hide: false` is a
 *  pass-through copy so callers can treat the result uniformly). */
export function filterStudioTraffic<E extends Pick<StudioTrafficEvent, 'operationContext'>>(
  events: readonly E[],
  hide: boolean,
): E[] {
  return hide ? events.filter((e) => !isStudioTraffic(e)) : [...events];
}

export type TrafficVerdict = 'allow' | 'deny' | 'bypassed' | 'proof-unsupported' | null;

/** The filter positions, `all` plus each real verdict. */
export type VerdictFilter = 'all' | 'allow' | 'deny' | 'bypassed' | 'proof-unsupported';

export const VERDICT_FILTERS: readonly VerdictFilter[] = ['all', 'allow', 'deny', 'proof-unsupported', 'bypassed'];

/**
 * Derive the verdict from the recorder's Rules disposition. Source and auth
 * lens are intentionally irrelevant here.
 */
export function verdictFor(event: {
  result?: string;
  queryProof?: RequestEvent['queryProof'];
  rulesDisposition: RulesDisposition;
}): TrafficVerdict {
  if (event.rulesDisposition.kind === 'bypassed') return 'bypassed';
  if (isQueryProofUnsupported(event)) return 'proof-unsupported';
  if (event.rulesDisposition.kind === 'evaluated') {
    return event.rulesDisposition.verdict;
  }
  return null;
}

/** Apply the verdict filter (`all` passes everything, including blanks). */
export function filterByVerdict<E extends { rulesDisposition: RulesDisposition }>(
  events: readonly E[],
  filter: VerdictFilter,
): E[] {
  if (filter === 'all') return [...events];
  return events.filter((e) => verdictFor(e) === filter);
}

/**
 * The acting identity for a row's disclosure: the lens when one was pinned
 * (impersonation / admin / anon), else the op's auth state.
 */
export function actingIdentity(event: {
  auth: StudioTrafficEvent['auth'];
  operationContext: OperationContext;
}): string {
  const lens = event.operationContext.authLens;
  switch (lens.mode) {
    case 'admin':
      return 'admin (rules bypassed)';
    case 'as':
      return `as ${lens.uid}`;
    case 'anon':
      return 'anonymous';
    case 'app-session':
      break;
  }
  return event.auth?.uid ? event.auth.uid : 'anonymous';
}

/** The reasons to show in a deny disclosure: the event's simulator reasoning
 *  lines (the same lines `denialContext.reasons` carries over the wire). */
export function denialReasons(event: { reasons?: readonly string[] }): string[] {
  return (event.reasons ?? []).filter((r) => r.trim() !== '');
}

/**
 * Row-click semantics: does this row open the RULES INSPECTOR in place?
 * True for rules-EVALUATED ops only (verdict allow or deny — there is a rules
 * decision to inspect). Admin-bypass rows (rules never ran) and blank-verdict
 * rows (non-rule ops) keep their subject navigation instead.
 */
export function opensRulesInspector(event: {
  rulesDisposition: RulesDisposition;
}): boolean {
  return event.rulesDisposition.kind === 'evaluated';
}

/** The `gs://<bucket>/` a Storage row's path starts with. */
const GS_BUCKET_PREFIX = /^gs:\/\/[^/]+\//;

/**
 * The route of the record a traffic row touched — the row's navigation
 * semantic (C3 drill-in: detail belongs to the owning surface). Null when
 * nothing addressable exists (service-level ops, the `(service)` path
 * placeholder the operation adapter writes when an op has no path).
 *
 *   firestore → /firestore/<path>     (doc or collection)
 *   rtdb      → /rtdb                 (the viewer's path is component state —
 *                                      N4 gap: no path deep-link yet)
 *   storage   → /storage/<path>       (object path)
 *             → /storage/<path>?kind=prefix (listed prefix)
 *             → /storage              (`gs://<bucket>/`, the bucket root; a
 *                                      `gs://<bucket>/` prefix is stripped)
 *   auth      → /auth/<uid>           (`path` carries the uid; `*` = clear-all,
 *                                      not addressable)
 */
export function subjectTarget(event: {
  service?: StudioTrafficEvent['service'];
  method: StudioTrafficEvent['method'];
  path: string;
}): CommandTarget | null {
  const isStorage = event.service === 'storage';
  const bucketPrefix = isStorage ? GS_BUCKET_PREFIX.exec(event.path) : null;
  // A Storage row reads `gs://<bucket>/<path>`; the pane routes by object path,
  // in its own bucket, and `gs://<bucket>/` is that bucket's root.
  if (bucketPrefix !== null) {
    const objectPath = event.path.slice(bucketPrefix[0].length);
    if (objectPath === '') return { tab: 'storage' };
    return subjectTarget({ ...event, path: objectPath });
  }
  const path = event.path;
  if (
    event.service === 'storage' &&
    event.method === 'list' &&
    (path === '' || path === '/')
  ) {
    return { tab: 'storage' };
  }
  if (!path || path === '(service)') return null;
  const rest = path.split('/').filter(Boolean);
  switch (event.service ?? 'firestore') {
    case 'firestore':
      return rest.length ? { tab: 'firestore', rest } : null;
    case 'rtdb':
      return { tab: 'rtdb' };
    case 'storage':
      return rest.length
        ? {
            tab: 'storage',
            rest,
            ...(event.method === 'list' ? { query: { kind: 'prefix' } } : {}),
          }
        : null;
    case 'auth':
      return path !== '*' ? { tab: 'auth', rest: [path] } : null;
    default:
      return null;
  }
}

/** Rules metrics exclude local proof limitations; operational metrics keep every event. */
export function rulesDecisionEvents<E extends Parameters<typeof verdictFor>[0]>(events: readonly E[]): E[] {
  return events.filter(event => {
    const verdict = verdictFor(event);
    return verdict === 'allow' || verdict === 'deny';
  });
}

export function queryProofUnsupportedCount(
  events: readonly (Parameters<typeof verdictFor>[0] & { at: number })[],
  window: { start: number; end: number },
): number {
  return events.filter(event => event.at >= window.start && event.at < window.end
    && verdictFor(event) === 'proof-unsupported').length;
}

export function verdictLabel(verdict: Exclude<TrafficVerdict, null> | 'all'): string {
  if (verdict === 'proof-unsupported') return 'Query proof unsupported';
  return verdict;
}

/**
 * The cell text for an op production served: production's answer, never a
 * local Rules verdict. `permission-denied` reads as denied; any other code
 * reads as failed and names the code.
 */
export function productionLabel(production: ObservedProduction): string {
  const outcome = production.outcome;
  if (outcome.status === 'ok') return 'production ok';
  return productionVerdict(outcome) === 'denied' ? 'production denied' : `production failed: ${outcome.code}`;
}

/** A local verdict that disagrees with production's: the local answer and the rule that decided it. */
export type LocalDrift = Extract<NonNullable<ObservedProduction['local']>, { result: 'allow' | 'deny' }>;

/**
 * The local rules' verdict on an op production served, only when it
 * disagrees with production's allow or deny. Undefined on an agreeing op, on
 * one the local rules could not decide, and on every op the sandbox served.
 */
export function localDrift(event: { production?: ObservedProduction }): LocalDrift | undefined {
  const local = event.production?.local;
  if (local === undefined || local.result === 'unevaluated') return undefined;
  return local.drift === true ? local : undefined;
}

/** The bounded evaluation record the host keeps on a live op's local verdict, as a sandbox request's `rulesEvidence`. */
type RulesEvidence = NonNullable<LocalDrift['trace']>;
type EvidenceRule = RulesEvidence['rules'][number];
type EvidenceCheck = EvidenceRule['checks'][number];

const LIVE_RESULTS = { ALLOW: 'allow', DENY: 'deny', UNSUPPORTED: 'unsupported' } as const;

/** One recorded check as the rules view's sub-expression trace entry. */
function traceEntryOf(check: EvidenceCheck): ExprTraceEntry {
  const entry: ExprTraceEntry = {
    source: check.expression,
    // The host records the simulator's own kind; a record without one reads as a plain name.
    kind: (check.kind ?? 'identifier') as ExprTraceEntry['kind'],
    parent: check.parent,
  };
  if (check.operator !== undefined) entry.operator = check.operator;
  if (check.binding !== undefined) entry.letBinding = { name: check.binding };
  if (check.helper !== undefined) entry.inlinedFrom = { name: check.helper };
  if (check.state === 'value') entry.value = check.value;
  if (check.state === 'skipped') entry.skipped = true;
  if (check.state === 'error') entry.error = check.error;
  return entry;
}

/** The rule that decided, as the sandbox picks it: the allowing rule, else the first that denied or failed, else the last. */
function decidingRule(trace: RulesEvidence): { rule: EvidenceRule; index: number } | undefined {
  const rules = trace.rules;
  const wanted = trace.decision === 'ALLOW'
    ? rules.findIndex((rule) => rule.verdict === 'ALLOW')
    : rules.findIndex((rule) => rule.verdict === 'DENY' || rule.verdict === 'ERROR');
  const index = wanted === -1 ? rules.length - 1 : wanted;
  const rule = rules[index];
  return rule === undefined ? undefined : { rule, index };
}

/**
 * A live Firestore op's local rules evaluation in the shape the sandbox
 * rules view reads, from the trace the host recorded on
 * `production.local.trace`. Undefined for an op with no trace: a sandbox op,
 * an unevaluated or RTDB verdict, or a trace too large to keep.
 */
export function liveRuleEvaluation(event: StudioTrafficEvent): Denial | undefined {
  const local = event.production?.local;
  const trace = local === undefined || local.result === 'unevaluated' ? undefined : local.trace;
  if (trace === undefined) return undefined;
  const result = LIVE_RESULTS[trace.decision];
  const denial: Denial = {
    id: event.id,
    at: event.at,
    result,
    method: event.method,
    service: event.service ?? 'firestore',
    path: event.path,
    auth: event.auth as Denial['auth'],
    reasons: [],
    origin: event.origin as Denial['origin'],
    unsupported: result === 'unsupported',
  };
  const deciding = decidingRule(trace);
  if (deciding === undefined) return denial;
  const { rule, index } = deciding;
  const decided = result === 'unsupported' ? undefined : result;
  if (decided !== undefined) {
    denial.evaluatedRule = {
      verdict: decided,
      ...(rule.line === undefined ? {} : { line: rule.line }),
      expression: rule.expression,
      expressionTrace: rule.checks.map(traceEntryOf),
    };
  }
  const operation = observedMethod('firestore', event.method);
  if (operation !== null) denial.matchedRule = { ruleIndex: index, operations: [operation] };
  return denial;
}
