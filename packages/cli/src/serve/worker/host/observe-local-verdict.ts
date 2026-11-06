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
 * A call may carry its token's claim values (`request.auth.token`), the data
 * a Firestore write sent (`request.resource.data`) and the document a
 * Firestore read returned (`resource.data`); the host feeds them to the
 * simulator from memory and keeps them off the event. It never carries a
 * `get()` or `exists()` document, an RTDB write's value or a query. A
 * verdict that rests on data the call did not carry is `unevaluated`,
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

/** The data one evaluation was given, which fills the gaps it would otherwise leave. */
interface Given {
  claims: boolean;
  writeData: boolean;
  document: boolean;
  /** Whether the write data is the whole document the write leaves, as a create's or a `setDoc`'s is and an `updateDoc`'s is not. */
  wholeWrite: boolean;
}

/** One way an expression reaches data: the gap it names, and whether the given data leaves it open. */
type GapPattern = [Gap, RegExp, (given: Given) => boolean];

const ALWAYS_OPEN = (): boolean => true;
const RESOURCE_READ = /(?<![\w.])resource\b/;
const LOOKUP = /\b(?:get|exists|getAfter|existsAfter)\s*\(/;
const WRITE_READ = /\brequest\.resource\b/;

/** What each gap looks like in an evaluated Firestore expression. */
const FIRESTORE_GAPS: readonly GapPattern[] = [
  ['stored-document', RESOURCE_READ, (given) => !given.document],
  ['stored-document', LOOKUP, ALWAYS_OPEN],
  ['write-data', WRITE_READ, (given) => !given.writeData],
  // An update's incoming document merges the written fields onto the stored one.
  ['stored-document', WRITE_READ, (given) => given.writeData && !given.wholeWrite],
  ['claim-values', /\brequest\.auth\.token\b/, (given) => !given.claims],
  ['query', /\brequest\.query\b/, ALWAYS_OPEN],
];

/** What each gap looks like in an RTDB rule expression. */
const RTDB_GAPS: readonly GapPattern[] = [
  ['stored-document', /\b(?:data|root)\b/, ALWAYS_OPEN],
  ['claim-values', /\bauth\.token\b/, (given) => !given.claims],
  ['query', /\bquery\./, ALWAYS_OPEN],
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

/** The union of two gap lists, in the patterns' order. */
function unionOf(first: Gap[], second: Gap[]): Gap[] {
  return GAP_ORDER.filter((gap) => first.includes(gap) || second.includes(gap));
}

/** The gaps a set of expressions reach that the given data leaves open, each once, in a fixed order. */
function gapsIn(expressions: ReadonlyArray<string | undefined>, patterns: readonly GapPattern[], given: Given): Gap[] {
  const reaches = (pattern: RegExp) => expressions.some((text) => text !== undefined && pattern.test(text));
  const open = patterns.filter(([, pattern, isOpen]) => isOpen(given) && reaches(pattern)).map(([gap]) => gap);
  return unionOf(open, []);
}

/** What the call carries for an evaluation of `method`. */
function givenBy(call: ObservedCall, method: ObservedMethod): Given {
  return {
    claims: call.account?.claims !== undefined,
    writeData: call.writeData !== undefined,
    document: call.document !== undefined,
    wholeWrite: method === 'create' || method === 'set',
  };
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

/** `request.auth` for the call: its uid, and its token's claims when the call carries their values. */
function authOf(call: ObservedCall): { uid: string; token: Record<string, unknown> } | null {
  const account = call.account;
  if (account === undefined) return null;
  const uid = account.uid;
  return { uid, token: { ...account.claims, sub: uid } };
}

/** A write's incoming data and a read's stored document, as a simulator case names them. */
function caseData(call: ObservedCall, method: Exclude<ObservedMethod, 'set'>): { data?: Record<string, unknown>; resource?: Record<string, unknown> } {
  const isWrite = method === 'create' || method === 'update';
  const data = isWrite ? call.writeData : undefined;
  // A create names no stored document; the simulator refuses one.
  const resource = method === 'create' ? undefined : call.document;
  return definedOnly({ data, resource });
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

/**
 * One Firestore method through the deployed rules' cached parse, with the
 * claim values, write data and stored document the call carries, or
 * `undefined` when the simulator abstains.
 */
function evaluateFirestore(ctx: HostCtx, call: ObservedCall, path: string, method: Exclude<ObservedMethod, 'set'>, given: Given): Evaluation | undefined {
  let looked = false;
  const simulated = getInternalEnv(ctx.sandbox).simulateDeployedRules(
    [{
      description: `${method} ${path}`,
      expectation: 'ALLOW',
      method,
      path,
      auth: authOf(call),
      ...caseData(call, method),
      requestTime: new Date(call.at).toISOString(),
    }],
    { getDoc: () => { looked = true; return null; } },
  );
  const result = simulated.success ? simulated.data.results[0] : undefined;
  if (result === undefined || result.decision === 'UNSUPPORTED') return undefined;
  const allowed = result.decision === 'ALLOW';
  const gaps = gapsIn(firestoreExpressions(result, allowed), FIRESTORE_GAPS, given);
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
  // Either way the written data is the whole document the set leaves.
  const given = givenBy(call, 'set');
  const create = evaluateFirestore(ctx, call, path, 'create', given);
  const update = evaluateFirestore(ctx, call, path, 'update', given);
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
  const evaluation = method === 'set' ? evaluateSetDoc(ctx, call, path) : evaluateFirestore(ctx, call, path, method, givenBy(call, method));
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
  return verdictOf(call, { allowed, rule, needs: gapsIn(expressions, RTDB_GAPS, givenBy(call, method)) });
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
