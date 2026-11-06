/**
 * The local rules' verdict on a call production served.
 *
 * A live host loads the app's rules files into the sandbox like any other.
 * When a client reports a Firestore or RTDB call production answered, the
 * host runs the same request through the sandbox's own simulator for that
 * service, with `request.auth` built from the uid the call carries, and
 * records what the local rules say beside production's answer. Production
 * decided, so this only reports: the event's result and Rules disposition
 * stay production's.
 *
 * An observed call carries no stored document, no written value and no
 * claim value. A verdict that rests on one of them is `unevaluated`, naming
 * what it needed, rather than a guess the local rules would not make with
 * the data in hand.
 */
import { SimulateFirestoreRulesHandler, projectEvaluatedRule } from 'pyric/rules/internal';
import { rtdbRules } from 'pyric/rules';
import { getActiveRules } from 'pyric/sandbox/database';
import { getInternalEnv, observedMethod, productionVerdict, type ObservedMethod } from 'pyric/sandbox/internal';
import type { ObservedCall, ObservedProduction } from 'pyric/sandbox';
import type { HostCtx } from '../host-context.js';
import { rtdbInstance } from './rtdb-instances.js';

type LocalVerdict = NonNullable<ObservedProduction['local']>;
type Gap = Extract<LocalVerdict, { result: 'unevaluated' }>['needs'][number];
type Decided = Extract<LocalVerdict, { result: 'allow' | 'deny' }>;

/** What each gap looks like in a Firestore condition. */
const FIRESTORE_GAPS: ReadonlyArray<[Gap, RegExp]> = [
  ['stored-document', /(?<![\w.])resource\b|\b(?:get|exists|getAfter|existsAfter)\s*\(/],
  ['write-data', /\brequest\.resource\b/],
  ['claim-values', /\brequest\.auth\.token\b/],
];

/** What each gap looks like in an RTDB rule expression. */
const RTDB_GAPS: ReadonlyArray<[Gap, RegExp]> = [
  ['stored-document', /\b(?:data|root)\b/],
  ['claim-values', /\bauth\.token\b/],
];

/** The RTDB rule kind each request method evaluates. */
const RTDB_OPERATION: Readonly<Record<ObservedMethod, 'read' | 'write'>> = {
  get: 'read',
  list: 'read',
  create: 'write',
  set: 'write',
  update: 'write',
  delete: 'write',
};

/** The gaps a set of rule conditions reach, in a fixed order. */
function gapsIn(conditions: ReadonlyArray<string | undefined>, patterns: ReadonlyArray<[Gap, RegExp]>): Gap[] {
  return patterns.filter(([, pattern]) => conditions.some((text) => text !== undefined && pattern.test(text))).map(([gap]) => gap);
}

/** A local answer, flagged as drift when it disagrees with production's allow or deny. */
function decided(call: ObservedCall, allowed: boolean, rule: Decided['rule']): Decided {
  const production = productionVerdict(call.outcome);
  const disagrees = (production === 'ok' && !allowed) || (production === 'denied' && allowed);
  return {
    result: allowed ? 'allow' : 'deny',
    ...(rule === undefined ? {} : { rule }),
    ...(disagrees ? { drift: true as const } : {}),
  };
}

/** Drop the keys whose value is undefined. */
function definedOnly<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function firestoreVerdict(ctx: HostCtx, call: ObservedCall, method: ObservedMethod): LocalVerdict | undefined {
  const source = getInternalEnv(ctx.sandbox).getRules();
  const path = call.path;
  if (source.length === 0 || path === undefined) return undefined;
  // `setDoc` is a create or an update depending on the stored document.
  if (method === 'set') return { result: 'unevaluated', needs: ['stored-document'] };
  let looked = false;
  const uid = call.account?.uid;
  const simulated = new SimulateFirestoreRulesHandler().simulate(
    source,
    [{
      description: `${method} ${path}`,
      expectation: 'ALLOW',
      method,
      path,
      auth: uid === undefined ? null : { uid, token: { sub: uid } },
      requestTime: new Date(call.at).toISOString(),
    }],
    { getDoc: () => { looked = true; return null; } },
  );
  const result = simulated.success ? simulated.data.results[0] : undefined;
  if (result === undefined || result.decision === 'UNSUPPORTED') return undefined;
  const allowed = result.decision === 'ALLOW';
  const deciding = projectEvaluatedRule(result);
  // An allow rests on its deciding rule; a deny on every rule it evaluated.
  const conditions = allowed ? [deciding?.expression] : result.trace.map((entry) => entry.conditionText);
  const gaps = gapsIn(conditions, FIRESTORE_GAPS);
  const needs: Gap[] = looked && !gaps.includes('stored-document') ? ['stored-document', ...gaps] : gaps;
  if (needs.length > 0) return { result: 'unevaluated', needs };
  const rule = deciding === undefined ? undefined : definedOnly({ line: deciding.line, expression: deciding.expression });
  return decided(call, allowed, rule);
}

function rtdbVerdict(ctx: HostCtx, call: ObservedCall, method: ObservedMethod): LocalVerdict | undefined {
  const ruleset = getActiveRules(rtdbInstance(ctx, call.instance).live);
  const path = call.path;
  if (ruleset === null || path === undefined) return undefined;
  const operation = RTDB_OPERATION[method];
  const isDelete = method === 'delete';
  // A write other than a remove is checked against its value, which an observed call does not carry yet.
  if (operation === 'write' && !isDelete) return { result: 'unevaluated', needs: ['write-data'] };
  const uid = call.account?.uid;
  const [result] = rtdbRules(ruleset).simulate([{
    expectation: 'ALLOW',
    operation,
    path: path.startsWith('/') ? path : `/${path}`,
    auth: uid === undefined ? null : { uid, token: { sub: uid } },
    data: {},
    now: call.at,
    // A remove writes null.
    ...(isDelete ? { newData: null } : {}),
  }]).cases;
  if (result === undefined || result.unsupported) return undefined;
  const allowed = result.decision === 'ALLOW';
  const deciding = result.trace.find((entry) => entry.conditionText === result.matchedRule);
  const conditions = allowed ? [result.matchedRule] : result.trace.map((entry) => entry.conditionText);
  const needs = gapsIn(conditions, RTDB_GAPS);
  if (needs.length > 0) return { result: 'unevaluated', needs };
  const rule = result.matchedRule === '' ? undefined : definedOnly({ path: deciding?.path ?? result.matchedPath, expression: result.matchedRule });
  return decided(call, allowed, rule);
}

/**
 * What the sandbox's loaded rules say about an observed call, or `undefined`
 * for a call no loaded rules govern: an Auth, AI or Messaging call, a listener
 * or transaction, a service with no rules loaded, or a Storage call, which
 * this host does not yet evaluate. Never throws: a local evaluation that
 * fails leaves the event as production answered it.
 */
export function localVerdict(ctx: HostCtx, call: ObservedCall): LocalVerdict | undefined {
  const method = observedMethod(call.service, call.method);
  if (method === null) return undefined;
  try {
    if (call.service === 'firestore') return firestoreVerdict(ctx, call, method);
    if (call.service === 'rtdb') return rtdbVerdict(ctx, call, method);
    return undefined;
  } catch {
    return undefined;
  }
}
