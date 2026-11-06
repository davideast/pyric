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
 * An observed call carries no stored document, no written value, no claim
 * value and no query. A verdict that rests on one of them is `unevaluated`,
 * naming what it needed, rather than a guess the local rules would not make
 * with the data in hand. A service whose rules file the app did not load
 * gets no verdict: the sandbox's stand-in rules are not the app's.
 */
import { rtdbRules, type RtdbRulesJson } from 'pyric/rules';
import { projectEvaluatedRule, type TestResult } from 'pyric/rules/internal';
import { getActiveRules } from 'pyric/sandbox/database';
import {
  getInternalEnv,
  LOCKED_DATABASE_RULES,
  observedMethod,
  productionVerdict,
  type ObservedMethod,
} from 'pyric/sandbox/internal';
import type { ObservedCall, ObservedProduction } from 'pyric/sandbox';
import type { HostCtx } from '../host-context.js';
import { rtdbInstance } from './rtdb-instances.js';

type LocalVerdict = NonNullable<ObservedProduction['local']>;
type Gap = Extract<LocalVerdict, { result: 'unevaluated' }>['needs'][number];
type Decided = Extract<LocalVerdict, { result: 'allow' | 'deny' }>;
type Rule = Decided['rule'];

/** One method's local answer: allowed or not, the deciding rule, and the data it needed. */
interface Evaluation {
  allowed: boolean;
  rule: Rule;
  needs: Gap[];
}

/** The order a verdict lists its gaps in. */
const GAP_ORDER: readonly Gap[] = ['stored-document', 'write-data', 'claim-values', 'query'];

/** What each gap looks like in an evaluated Firestore expression. */
const FIRESTORE_GAPS: ReadonlyArray<[Gap, RegExp]> = [
  ['stored-document', /(?<![\w.])resource\b|\b(?:get|exists|getAfter|existsAfter)\s*\(/],
  ['write-data', /\brequest\.resource\b/],
  ['claim-values', /\brequest\.auth\.token\b/],
  ['query', /\brequest\.query\b/],
];

/** What each gap looks like in an RTDB rule expression. */
const RTDB_GAPS: ReadonlyArray<[Gap, RegExp]> = [
  ['stored-document', /\b(?:data|root)\b/],
  ['claim-values', /\bauth\.token\b/],
  ['query', /\bquery\./],
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

/** The gaps a set of expressions reach, in a fixed order. */
function gapsIn(expressions: ReadonlyArray<string | undefined>, patterns: ReadonlyArray<[Gap, RegExp]>): Gap[] {
  const reaches = (pattern: RegExp) => expressions.some((text) => text !== undefined && pattern.test(text));
  return patterns.filter(([, pattern]) => reaches(pattern)).map(([gap]) => gap);
}

/** The union of two gap lists, in the patterns' order. */
function unionOf(first: Gap[], second: Gap[]): Gap[] {
  return GAP_ORDER.filter((gap) => first.includes(gap) || second.includes(gap));
}

/** Drop the keys whose value is undefined. */
function definedOnly<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/** An evaluation as a verdict: unevaluated when it needed data, else flagged as drift when it disagrees with production. */
function verdictOf(call: ObservedCall, evaluation: Evaluation): LocalVerdict {
  if (evaluation.needs.length > 0) return { result: 'unevaluated', needs: evaluation.needs };
  const { allowed, rule } = evaluation;
  const production = productionVerdict(call.outcome);
  const disagrees = (production === 'ok' && !allowed) || (production === 'denied' && allowed);
  return {
    result: allowed ? 'allow' : 'deny',
    ...(rule === undefined ? {} : { rule }),
    ...(disagrees ? { drift: true as const } : {}),
  };
}

function authOf(call: ObservedCall): { uid: string; token: { sub: string } } | null {
  const uid = call.account?.uid;
  return uid === undefined ? null : { uid, token: { sub: uid } };
}

/**
 * Every expression a Firestore result evaluated that its verdict rests on,
 * function bodies included (the trace inlines them): the deciding rule's for
 * an allow, every rule's for a deny.
 */
function firestoreExpressions(result: TestResult, allowed: boolean): string[] {
  const entries = allowed ? result.trace.filter((entry) => entry.verdict === 'ALLOW').slice(0, 1) : result.trace;
  return entries.flatMap((entry) => [entry.conditionText ?? '', ...(entry.expressionTrace ?? []).map((node) => node.source)]);
}

/** Whether the host loaded the app's own Firestore rules, rather than running the sandbox's open default. */
function hasAppFirestoreRules(ctx: HostCtx, source: string): boolean {
  const loaded = ctx.activeRules?.firestore?.source;
  return typeof loaded === 'string' && loaded === source;
}

/** One Firestore method through the deployed rules' cached parse, or `undefined` when the simulator abstains. */
function evaluateFirestore(ctx: HostCtx, call: ObservedCall, path: string, method: Exclude<ObservedMethod, 'set'>): Evaluation | undefined {
  let looked = false;
  const simulated = getInternalEnv(ctx.sandbox).simulateDeployedRules(
    [{
      description: `${method} ${path}`,
      expectation: 'ALLOW',
      method,
      path,
      auth: authOf(call),
      requestTime: new Date(call.at).toISOString(),
    }],
    { getDoc: () => { looked = true; return null; } },
  );
  const result = simulated.success ? simulated.data.results[0] : undefined;
  if (result === undefined || result.decision === 'UNSUPPORTED') return undefined;
  const allowed = result.decision === 'ALLOW';
  const gaps = gapsIn(firestoreExpressions(result, allowed), FIRESTORE_GAPS);
  const needs = looked ? unionOf(['stored-document'], gaps) : gaps;
  const deciding = projectEvaluatedRule(result);
  const rule = deciding === undefined ? undefined : definedOnly({ line: deciding.line, expression: deciding.expression });
  return { allowed, rule, needs };
}

/**
 * `setDoc` is a create or an update depending on the stored document, so it
 * is evaluated as both: one answer when they agree, else the data that
 * would tell them apart.
 */
function evaluateSetDoc(ctx: HostCtx, call: ObservedCall, path: string): Evaluation | undefined {
  const create = evaluateFirestore(ctx, call, path, 'create');
  const update = evaluateFirestore(ctx, call, path, 'update');
  if (create === undefined || update === undefined) return undefined;
  const needs = unionOf(create.needs, update.needs);
  const agrees = create.allowed === update.allowed;
  if (agrees) return { ...create, needs };
  return { ...create, needs: unionOf(['stored-document'], needs) };
}

function firestoreVerdict(ctx: HostCtx, call: ObservedCall, method: ObservedMethod): LocalVerdict | undefined {
  const source = getInternalEnv(ctx.sandbox).getRules();
  const path = call.path;
  if (!hasAppFirestoreRules(ctx, source) || path === undefined) return undefined;
  const evaluation = method === 'set' ? evaluateSetDoc(ctx, call, path) : evaluateFirestore(ctx, call, path, method);
  return evaluation === undefined ? undefined : verdictOf(call, evaluation);
}

/** The rules the app deployed to an RTDB instance, or `null` for none or the locked stand-in. */
function appRtdbRules(ctx: HostCtx, instance: string | undefined): RtdbRulesJson | null {
  const entry = rtdbInstance(ctx, instance);
  const deployed = entry.rules?.source;
  const isAppRules = deployed !== undefined && deployed !== null && deployed !== LOCKED_DATABASE_RULES;
  return isAppRules ? getActiveRules(entry.live) : null;
}

function rtdbVerdict(ctx: HostCtx, call: ObservedCall, method: ObservedMethod): LocalVerdict | undefined {
  const ruleset = appRtdbRules(ctx, call.instance);
  const path = call.path;
  if (ruleset === null || path === undefined) return undefined;
  const operation = RTDB_OPERATION[method];
  const isDelete = method === 'delete';
  // A write other than a remove is checked against its value, which an observed call does not carry yet.
  if (operation === 'write' && !isDelete) return { result: 'unevaluated', needs: ['write-data'] };
  const [result] = rtdbRules(ruleset).simulate([{
    expectation: 'ALLOW',
    operation,
    path: path.startsWith('/') ? path : `/${path}`,
    auth: authOf(call),
    data: {},
    now: call.at,
    // A remove writes null.
    ...(isDelete ? { newData: null } : {}),
  }]).cases;
  if (result === undefined || result.unsupported) return undefined;
  const allowed = result.decision === 'ALLOW';
  const deciding = result.trace.find((entry) => entry.conditionText === result.matchedRule);
  const expressions = allowed ? [result.matchedRule] : result.trace.map((entry) => entry.conditionText);
  const hasRule = result.matchedRule !== '';
  const rule = hasRule ? definedOnly({ path: deciding?.path ?? result.matchedPath, expression: result.matchedRule }) : undefined;
  return verdictOf(call, { allowed, rule, needs: gapsIn(expressions, RTDB_GAPS) });
}

/**
 * What the app's loaded rules say about an observed call, or `undefined`
 * for a call no loaded rules govern: an Auth, AI or Messaging call, a listener
 * or transaction, a service whose rules file the app did not load, or a
 * Storage call, which this host does not yet evaluate. Never throws: a local
 * evaluation that fails leaves the event as production answered it.
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
