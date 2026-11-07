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
 * simulator from memory and keeps them off the event, except as the scalar
 * check values a Firestore verdict's trace holds, as a sandbox request's
 * `rulesEvidence` does, with every email address left out. It never carries a
 * `get()` or `exists()` document, an RTDB write's value or a query. A
 * verdict that rests on data the call did not carry is `unevaluated`,
 * naming what it needed, rather than a guess the local rules would not make
 * with the data in hand. A service whose rules file the app did not load
 * gets no verdict: the sandbox's stand-in rules are not the app's.
 */
import type { RtdbRulesJson } from 'pyric/rules';
import { projectEvaluatedRule, type TestCase, type TestResult } from 'pyric/rules/internal';
import {
  collectRtdbRuleAncestors,
  compileRtdbRules,
  rtdbWildcardChild,
  simulateRtdbRules,
  type CompiledRtdbRules,
  type RtdbRuleEvaluation,
} from 'pyric/rules/internal/rtdb';
import { getActiveRules } from 'pyric/sandbox/database';
import {
  captureRulesEvidence,
  EMAIL_SHAPE,
  getInternalEnv,
  LOCKED_DATABASE_RULES,
  observedMethod,
  productionVerdict,
  rtdbRulesMethod,
  type LocalRtdbEvaluation,
  type ObservedMethod,
} from 'pyric/sandbox/internal';
import type { ObservedCall, ObservedProduction } from 'pyric/sandbox';
import type { HostCtx } from '../host-context.js';
import { rtdbInstance } from './rtdb-instances.js';

type LocalVerdict = NonNullable<ObservedProduction['local']>;
type Unevaluated = Extract<LocalVerdict, { result: 'unevaluated' }>;
type Gap = Unevaluated['needs'][number];
type Decided = Extract<LocalVerdict, { result: 'allow' | 'deny' }>;
type Rule = Decided['rule'];
type Trace = NonNullable<Decided['trace']>;
type RtdbLocal = LocalRtdbEvaluation;

/** One method's local answer: allowed or not, the deciding rule, the data it needed, and its evaluation trace. */
export interface Evaluation {
  allowed: boolean;
  rule: Rule;
  needs: Gap[];
  trace?: Trace;
  rtdb?: RtdbLocal;
}

/** The largest trace, in bytes of JSON, a verdict keeps; a larger one is dropped and the verdict kept. */
const TRACE_LIMIT = 16 * 1024;

/** The trace's rules version: the host's loaded rules, which a sandbox request's random id does not name. */
const LOCAL_TRACE_VERSION = 'local-rules';

/** The order a verdict lists its gaps in. */
const GAP_ORDER: readonly Gap[] = ['stored-document', 'write-data', 'claim-values', 'query'];

/** The data one evaluation was given, which fills the gaps it would otherwise leave. */
interface Given {
  claims: boolean;
  /** Whether the claims keep the account's email; a captured call's never do. */
  emails: boolean;
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
/** A token's email claim, top level or among its sign-in identities. */
const EMAIL_CLAIM = /\brequest\.auth\.token\.(?:email\b|firebase\.identities\b)/;

/** What each gap looks like in an evaluated Firestore expression. */
const FIRESTORE_GAPS: readonly GapPattern[] = [
  ['stored-document', RESOURCE_READ, (given) => !given.document],
  ['stored-document', LOOKUP, ALWAYS_OPEN],
  ['write-data', WRITE_READ, (given) => !given.writeData],
  // An update's incoming document merges the written fields onto the stored one.
  ['stored-document', WRITE_READ, (given) => given.writeData && !given.wholeWrite],
  ['claim-values', /\brequest\.auth\.token\b/, (given) => !given.claims],
  // Emails are left out of the claims a call keeps.
  ['claim-values', EMAIL_CLAIM, (given) => !given.emails],
  ['query', /\brequest\.query\b/, ALWAYS_OPEN],
];

const RTDB_EMAIL_CLAIM = /\bauth\.token\.(?:email\b|firebase\.identities\b)/;

/** What each gap looks like in an RTDB rule expression. */
const RTDB_GAPS: readonly GapPattern[] = [
  ['stored-document', /(?<![\w.])(?:data|root)\b/, ALWAYS_OPEN],
  ['claim-values', /\bauth\.token\b/, (given) => !given.claims],
  ['claim-values', RTDB_EMAIL_CLAIM, (given) => !given.emails],
  ['query', /(?<![\w.])query\./, ALWAYS_OPEN],
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
    emails: call.account?.claims?.email !== undefined,
    writeData: call.writeData !== undefined,
    document: call.document !== undefined,
    wholeWrite: method === 'create' || method === 'set',
  };
}

/** Drop the keys whose value is undefined. */
function definedOnly<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/** The email values the call's claims carry, top level or among its sign-in identities. */
function emailsOf(call: ObservedCall): string[] {
  const claims = call.account?.claims;
  if (claims === undefined) return [];
  const firebase = claims.firebase as { identities?: { email?: unknown } } | undefined;
  const identityEmails = firebase?.identities?.email;
  const listed = Array.isArray(identityEmails) ? identityEmails : [];
  return [claims.email, ...listed].filter((value): value is string => typeof value === 'string' && value !== '');
}

/** A value the trace capture records as `unavailable`, as it does any non-scalar. */
const WITHHELD = Object.freeze({});

type TraceRule = TestResult['trace'][number];
type TraceEntry = NonNullable<TraceRule['expressionTrace']>[number];

/** Whether `text` holds an email address or one of the account's `emails`. */
function holdsEmail(text: string | undefined, emails: string[]): boolean {
  if (text === undefined) return false;
  return EMAIL_SHAPE.test(text) || emails.some((email) => text.includes(email));
}

/** One evaluated expression with its value or error withheld when it holds an email. */
function entryWithoutEmail(entry: TraceEntry, emails: string[]): TraceEntry {
  const text = typeof entry.value === 'string' ? entry.value : entry.error;
  if (!holdsEmail(text, emails)) return entry;
  const { error: _error, ...withoutError } = entry;
  return { ...withoutError, value: WITHHELD };
}

/** One evaluated rule with its email-holding values and message left out. */
function ruleWithoutEmail(rule: TraceRule, emails: string[]): TraceRule {
  const { message, ...rest } = rule;
  const kept = holdsEmail(message, emails) ? rest : rule;
  const entries = rule.expressionTrace;
  if (entries === undefined) return kept;
  return { ...kept, expressionTrace: entries.map((entry) => entryWithoutEmail(entry, emails)) };
}

/**
 * A simulator result's trace as the event may hold it: every value, error
 * or message that holds an email address withheld before the capture
 * truncates its text, so a cut-off address cannot pass.
 */
function traceOf(result: TestResult, call: ObservedCall): Trace {
  const emails = emailsOf(call);
  const trace = result.trace.map((rule) => ruleWithoutEmail(rule, emails));
  return captureRulesEvidence({ ...result, trace }, LOCAL_TRACE_VERSION);
}

function bindingsWithoutEmail(bindings: Record<string, string>, emails: string[]): Record<string, string> {
  const scrubbed: Record<string, string> = {};
  for (const [key, value] of Object.entries(bindings)) {
    if (!holdsEmail(value, emails)) scrubbed[key] = value;
  }
  return scrubbed;
}

/** One RTDB trace entry with any email-holding message or binding omitted. */
function rtdbTraceEntryWithoutEmail(entry: RtdbRuleEvaluation, emails: string[]): RtdbRuleEvaluation {
  const pathVariableBindings = bindingsWithoutEmail(entry.pathVariableBindings, emails);
  if (!holdsEmail(entry.message, emails)) return { ...entry, pathVariableBindings };
  const { message: _message, ...withoutMessage } = entry;
  return { ...withoutMessage, pathVariableBindings };
}

function withinByteCap(value: unknown): boolean {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= TRACE_LIMIT;
}

/** The trace a verdict keeps, or `undefined` when its JSON is larger than the cap in bytes. */
function keptTrace(trace: Trace | undefined): Trace | undefined {
  if (trace === undefined) return undefined;
  return withinByteCap(trace) ? trace : undefined;
}

/** The RTDB local record a verdict keeps, dropping `rtdbTrace` first if it exceeds the byte cap. */
function keptRtdb(rtdb: RtdbLocal | undefined): RtdbLocal | undefined {
  if (rtdb === undefined) return undefined;
  if (withinByteCap(rtdb)) return rtdb;
  if (rtdb.rtdbTrace === undefined) return undefined;
  const { rtdbTrace: _rtdbTrace, ...withoutTrace } = rtdb;
  if (Object.keys(withoutTrace).length === 0) return undefined;
  return withinByteCap(withoutTrace) ? withoutTrace : undefined;
}

/** Strips simulated verdicts/reasons from an unevaluated RTDB record, keeping only rule-node context. */
function unevaluatedRtdbOf(rtdb: RtdbLocal): RtdbLocal | undefined {
  const context: RtdbLocal = {};
  if (rtdb.matchedPath !== undefined && rtdb.matchedPath !== '') {
    context.matchedPath = rtdb.matchedPath;
  }
  if (rtdb.matchedRule !== undefined && rtdb.matchedRule !== '') {
    context.matchedRule = rtdb.matchedRule;
  }
  const bindings = rtdb.pathVariableBindings;
  if (bindings !== undefined && Object.keys(bindings).length > 0) {
    context.pathVariableBindings = bindings;
  }
  return Object.keys(context).length === 0 ? undefined : context;
}

/**
 * An evaluation as a verdict: unevaluated when it needed data, else flagged as
 * drift when it disagrees with production. An unevaluated verdict keeps the
 * rule the simulation evaluated with the data missing, which is context for
 * the gap and not a deciding rule.
 */
function verdictOf(call: ObservedCall, evaluation: Evaluation): LocalVerdict {
  if (evaluation.needs.length > 0) {
    const unevaluated: Unevaluated = { result: 'unevaluated', needs: evaluation.needs };
    if (evaluation.rule !== undefined) unevaluated.rule = evaluation.rule;
    if (evaluation.rtdb !== undefined) {
      const context = keptRtdb(unevaluatedRtdbOf(evaluation.rtdb));
      if (context !== undefined) unevaluated.rtdb = context;
    }
    return unevaluated;
  }
  const { allowed, rule } = evaluation;
  const production = productionVerdict(call.outcome);
  const disagrees = (production === 'ok' && !allowed) || (production === 'denied' && allowed);
  const trace = keptTrace(evaluation.trace);
  const rtdb = keptRtdb(evaluation.rtdb);
  const verdict: Decided = { result: allowed ? 'allow' : 'deny' };
  if (rule !== undefined) verdict.rule = rule;
  if (disagrees) verdict.drift = true;
  if (trace !== undefined) verdict.trace = trace;
  if (rtdb !== undefined) verdict.rtdb = rtdb;
  return verdict;
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
 * A Firestore rules simulator with its rules bound: the host's deployed
 * rules' cached parse, or `pyric verify`'s candidate rules.
 */
export type FirestoreSimulate = (
  cases: TestCase[],
  lookups: { getDoc: (path: string) => null },
) => { success: true; data: { results: TestResult[] } } | { success: false };

/**
 * One Firestore method through `simulate`, with the claim values, write
 * data and stored document the call carries, or `undefined` when the
 * simulator abstains.
 */
function evaluateFirestore(simulate: FirestoreSimulate, call: ObservedCall, path: string, method: Exclude<ObservedMethod, 'set'>, given: Given): Evaluation | undefined {
  let looked = false;
  const simulated = simulate(
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
  return { allowed, rule, needs, trace: traceOf(result, call) };
}

/**
 * `setDoc` is a create or an update depending on the stored document, so it
 * is evaluated as both: one answer when they agree, else the data that
 * would tell them apart.
 */
function evaluateSetDoc(simulate: FirestoreSimulate, call: ObservedCall, path: string): Evaluation | undefined {
  // Either way the written data is the whole document the set leaves.
  const given = givenBy(call, 'set');
  const create = evaluateFirestore(simulate, call, path, 'create', given);
  const update = evaluateFirestore(simulate, call, path, 'update', given);
  if (create === undefined || update === undefined) return undefined;
  const needs = unionOf(create.needs, update.needs);
  const agrees = create.allowed === update.allowed;
  if (agrees) return { ...create, needs };
  // Which branch applies rests on the stored document, so neither branch's rule is the one that decides.
  return { allowed: create.allowed, rule: undefined, needs: unionOf(['stored-document'], needs) };
}

/**
 * One observed Firestore call through `simulate`: allowed or not, the
 * deciding rule, and the data the answer needed that the call did not carry
 * (an answer that needs any is not one the rules would give). `undefined`
 * for a call with no path or one the simulator abstains on. `pyric verify`
 * replays captured live calls through this with the candidate rules.
 */
export function evaluateFirestoreCall(simulate: FirestoreSimulate, call: ObservedCall, method: ObservedMethod): Evaluation | undefined {
  const path = call.path;
  if (path === undefined) return undefined;
  if (method === 'set') return evaluateSetDoc(simulate, call, path);
  return evaluateFirestore(simulate, call, path, method, givenBy(call, method));
}

function firestoreVerdict(ctx: HostCtx, call: ObservedCall, method: ObservedMethod): LocalVerdict | undefined {
  const env = getInternalEnv(ctx.sandbox);
  if (!hasAppFirestoreRules(ctx, env.getRules())) return undefined;
  const evaluation = evaluateFirestoreCall((cases, lookups) => env.simulateDeployedRules(cases, lookups), call, method);
  return evaluation === undefined ? undefined : verdictOf(call, evaluation);
}

/** The rules the app deployed to an RTDB instance, or `null` for none or the locked stand-in. */
function appRtdbRules(ctx: HostCtx, instance: string | undefined): RtdbRulesJson | null {
  const entry = rtdbInstance(ctx, instance);
  const deployed = entry.rules?.source;
  const isAppRules = deployed !== undefined && deployed !== null && deployed !== LOCKED_DATABASE_RULES;
  return isAppRules ? getActiveRules(entry.live) : null;
}

/**
 * An RTDB write other than `remove` carries no `newData`, so local rules cannot
 * finish proof, yet the compiled rule tree still names the `.write` node and
 * `$variable` bindings along `normalizedPath` (or the `$wildcard` child for `push`).
 */
function rtdbWriteUnevaluated(
  compiled: CompiledRtdbRules,
  call: ObservedCall,
  normalizedPath: string,
  method: ObservedMethod,
): LocalVerdict {
  const segments = normalizedPath.split('/').filter(Boolean);
  const steps = collectRtdbRuleAncestors(compiled, segments);
  const walkedTo = steps[steps.length - 1];
  const matchedAllSegments = steps.length === segments.length + 1;
  // A push writes a new key under the path, which only the `$wildcard` child rule can govern.
  const pushed = call.method === 'push' && matchedAllSegments ? rtdbWildcardChild(walkedTo.node) : undefined;
  if (pushed !== undefined) {
    steps.push({ node: pushed.child, pathVariableBindings: walkedTo.pathVariableBindings, depth: walkedTo.depth + 1 });
  }
  const expressions = steps.flatMap((step) => [step.node.write?.raw, step.node.validate?.raw]);
  const extraNeeds = gapsIn(expressions, RTDB_GAPS, givenBy(call, method));
  const needs = unionOf(['write-data'], extraNeeds);
  const decidingWrite = [...steps].reverse().find((step) => step.node.write !== undefined);
  const deepestStep = steps[steps.length - 1];
  const emails = emailsOf(call);
  let rule: Rule;
  let rtdb: RtdbLocal | undefined;
  if (decidingWrite !== undefined && decidingWrite.node.write !== undefined) {
    const raw = decidingWrite.node.write.raw;
    rule = { path: decidingWrite.node.path, expression: raw };
    rtdb = { matchedPath: decidingWrite.node.path, matchedRule: raw };
    const cleanBindings = bindingsWithoutEmail(decidingWrite.pathVariableBindings, emails);
    if (Object.keys(cleanBindings).length > 0) {
      rtdb.pathVariableBindings = cleanBindings;
    }
  } else {
    const cleanBindings = bindingsWithoutEmail(deepestStep.pathVariableBindings, emails);
    if (Object.keys(cleanBindings).length > 0) {
      rtdb = { pathVariableBindings: cleanBindings };
    }
  }
  const verdict: Unevaluated = { result: 'unevaluated', needs };
  if (rule !== undefined) verdict.rule = rule;
  const boundedRtdb = keptRtdb(rtdb);
  if (boundedRtdb !== undefined) verdict.rtdb = boundedRtdb;
  return verdict;
}

function rtdbVerdict(ctx: HostCtx, call: ObservedCall, method: ObservedMethod): LocalVerdict | undefined {
  const ruleset = appRtdbRules(ctx, call.instance);
  const path = call.path;
  if (ruleset === null || path === undefined) return undefined;
  const compiled = compileRtdbRules(ruleset);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const operation = RTDB_OPERATION[method];
  const isDelete = method === 'delete';
  // A write other than a remove is checked against its value, which an observed call does not carry yet.
  if (operation === 'write' && !isDelete) {
    return rtdbWriteUnevaluated(compiled, call, normalizedPath, method);
  }
  const simInput: Parameters<typeof simulateRtdbRules>[1] = {
    operation,
    path: normalizedPath,
    auth: authOf(call),
    mockData: {},
    now: call.at,
  };
  if (isDelete) simInput.newData = null;
  const simulated = simulateRtdbRules(compiled, simInput);
  if (!simulated.success || simulated.data.unsupported) return undefined;
  const data = simulated.data;
  const allowed = data.allowed;
  const emails = emailsOf(call);
  const scrubbedTrace = data.trace.map((entry) => rtdbTraceEntryWithoutEmail(entry, emails));
  const expressions = allowed ? [data.matchedRule] : data.trace.map((entry) => entry.conditionText);
  const hasRule = data.matchedRule !== '';
  const rule = hasRule ? definedOnly({ path: data.matchedPath, expression: data.matchedRule }) : undefined;
  const rtdb: RtdbLocal = {
    matchedPath: data.matchedPath,
    matchedRule: data.matchedRule,
    rtdbTrace: scrubbedTrace,
  };
  const cleanBindings = bindingsWithoutEmail(data.pathVariableBindings, emails);
  if (Object.keys(cleanBindings).length > 0) {
    rtdb.pathVariableBindings = cleanBindings;
  }
  if (data.reason !== '' && !holdsEmail(data.reason, emails)) {
    rtdb.reason = data.reason;
  }
  if (!allowed && data.matchedPath === '') {
    rtdb.errorCode = 'NO_MATCHING_RULE';
  }
  return verdictOf(call, {
    allowed,
    rule,
    needs: gapsIn(expressions, RTDB_GAPS, givenBy(call, method)),
    rtdb,
  });
}

/**
 * What the app's loaded rules say about an observed call, or `undefined`
 * for a call no loaded rules govern: an Admin SDK call, an Auth, AI or
 * Messaging call, a Firestore listener or transaction, an RTDB transaction or
 * `onDisconnect`, a service whose rules file the app did not load, or a
 * Storage call, which this host does not yet evaluate. Never throws: a local
 * evaluation that fails leaves the event as production answered it.
 */
export function localVerdict(ctx: HostCtx, call: ObservedCall): LocalVerdict | undefined {
  if (call.sdk === 'admin') return undefined;
  try {
    if (call.service === 'firestore') {
      const method = observedMethod('firestore', call.method);
      return method === null ? undefined : firestoreVerdict(ctx, call, method);
    }
    if (call.service === 'rtdb') {
      const method = rtdbRulesMethod(call.method);
      return method === null ? undefined : rtdbVerdict(ctx, call, method);
    }
    return undefined;
  } catch {
    return undefined;
  }
}
