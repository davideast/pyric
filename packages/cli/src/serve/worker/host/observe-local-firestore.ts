/**
 * The local Firestore rules' verdict on an observed Firestore call.
 *
 * The host runs the call through the deployed rules' simulator with the
 * claim values, written data and stored document the call carries. A
 * Firestore verdict keeps the simulator's trace, as a sandbox request's
 * `rulesEvidence` does. `pyric verify` replays captured live calls through
 * `evaluateFirestoreCall` with candidate rules.
 */
import { projectEvaluatedRule, type TestCase, type TestResult } from 'pyric/rules/internal';
import { captureRulesEvidence, getInternalEnv, type ObservedMethod } from 'pyric/sandbox/internal';
import type { ObservedCall } from 'pyric/sandbox';
import type { HostCtx } from '../host-context.js';
import {
  ALWAYS_OPEN,
  authOf,
  definedOnly,
  gapsIn,
  givenBy,
  isPlainRecord,
  unionOf,
  verdictOf,
  type Evaluation,
  type GapPattern,
  type Given,
  type LocalVerdict,
} from './observe-local-evaluation.js';

/** The trace's rules version: the host's loaded rules, which a sandbox request's random id does not name. */
const LOCAL_TRACE_VERSION = 'local-rules';

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
  // Legacy captures and calls without claimNames cannot tell whether the token carried an email.
  ['claim-values', EMAIL_CLAIM, (given) => !given.emailKnown],
  ['query', /\brequest\.query\b/, ALWAYS_OPEN],
];

/** A write's incoming data and a read's stored document, as a simulator case names them. */
function caseData(call: ObservedCall, method: Exclude<ObservedMethod, 'set'>): { data?: Record<string, unknown>; resource?: Record<string, unknown> } {
  const isWrite = method === 'create' || method === 'update';
  const data = isWrite && isPlainRecord(call.writeData) ? call.writeData : undefined;
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
  return { allowed, rule, needs, trace: captureRulesEvidence(result, LOCAL_TRACE_VERSION) };
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

/** The app's Firestore rules' verdict on an observed Firestore call, or `undefined` when the app loaded none. */
export function firestoreVerdict(ctx: HostCtx, call: ObservedCall, method: ObservedMethod): LocalVerdict | undefined {
  const env = getInternalEnv(ctx.sandbox);
  if (!hasAppFirestoreRules(ctx, env.getRules())) return undefined;
  const evaluation = evaluateFirestoreCall((cases, lookups) => env.simulateDeployedRules(cases, lookups), call, method);
  return evaluation === undefined ? undefined : verdictOf(call, evaluation);
}
