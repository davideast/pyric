/**
 * One local evaluation of an observed call, and the verdict it becomes.
 *
 * Each service's local-rules engine (`observe-local-firestore.ts`,
 * `observe-local-rtdb.ts`, `observe-local-storage.ts`) answers with an
 * `Evaluation`: allowed or not, the deciding rule, and the data its answer
 * rested on that the call did not carry. `verdictOf` turns that into the
 * verdict an event keeps: `unevaluated`, naming the data it needed, when it
 * has any gap, else allow or deny flagged as drift when it disagrees with
 * production's answer. Every engine shares the gap vocabulary and the byte
 * caps here.
 */
import {
  productionVerdict,
  type LocalRtdbEvaluation,
  type LocalStorageEvaluation,
  type ObservedMethod,
} from 'pyric/sandbox/internal';
import type { ObservedCall, ObservedProduction } from 'pyric/sandbox';

export type LocalVerdict = NonNullable<ObservedProduction['local']>;
type Unevaluated = Extract<LocalVerdict, { result: 'unevaluated' }>;
export type Gap = Unevaluated['needs'][number];
type Decided = Extract<LocalVerdict, { result: 'allow' | 'deny' }>;
export type Rule = Decided['rule'];
export type Trace = NonNullable<Decided['trace']>;
export type RtdbLocal = LocalRtdbEvaluation;
export type StorageLocal = LocalStorageEvaluation;

/** One method's local answer: allowed or not, the deciding rule, the data it needed, and its evaluation trace. */
export interface Evaluation {
  allowed: boolean;
  rule: Rule;
  needs: Gap[];
  trace?: Trace;
  rtdb?: RtdbLocal;
  storage?: StorageLocal;
}

/** The largest trace, in bytes of JSON, a verdict keeps; a larger one is dropped and the verdict kept. */
const TRACE_LIMIT = 16 * 1024;

/** The order a verdict lists its gaps in. */
const GAP_ORDER: readonly Gap[] = ['stored-document', 'write-data', 'claim-values', 'query'];

/** The data one evaluation was given, which fills the gaps it would otherwise leave. */
export interface Given {
  claims: boolean;
  /** Whether the call's claims establish the account's email (present, or absent from `claimNames`). */
  emailKnown: boolean;
  writeData: boolean;
  document: boolean;
  /** Whether the write data is the whole document the write leaves, as a create's or a `setDoc`'s is and an `updateDoc`'s is not. */
  wholeWrite: boolean;
}

/** One way an expression reaches data: the gap it names, and whether the given data leaves it open. */
export type GapPattern = [Gap, RegExp, (given: Given) => boolean];

export const ALWAYS_OPEN = (): boolean => true;

/** The union of two gap lists, in the patterns' order. */
export function unionOf(first: Gap[], second: Gap[]): Gap[] {
  return GAP_ORDER.filter((gap) => first.includes(gap) || second.includes(gap));
}

/** The gaps a set of expressions reach that the given data leaves open, each once, in a fixed order. */
export function gapsIn(expressions: ReadonlyArray<string | undefined>, patterns: readonly GapPattern[], given: Given): Gap[] {
  const reaches = (pattern: RegExp) => expressions.some((text) => text !== undefined && pattern.test(text));
  const open = patterns.filter(([, pattern, isOpen]) => isOpen(given) && reaches(pattern)).map(([gap]) => gap);
  return unionOf(open, []);
}

/** What the call carries for an evaluation of `method`. */
export function givenBy(call: ObservedCall, method: ObservedMethod): Given {
  const hasEmailClaim = call.account?.claims?.email !== undefined;
  const tokenHasNoEmail =
    call.account?.claims !== undefined &&
    call.account.claimNames !== undefined &&
    !call.account.claimNames.includes('email');
  return {
    claims: call.account?.claims !== undefined,
    emailKnown: hasEmailClaim || tokenHasNoEmail,
    writeData: call.writeData !== undefined,
    document: call.document !== undefined,
    wholeWrite: method === 'create' || method === 'set',
  };
}

/** Drop the keys whose value is undefined. */
export function definedOnly<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
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

/** Strips simulated reasons from an unevaluated Storage record, keeping only rule-node context. */
function unevaluatedStorageOf(storage: StorageLocal): StorageLocal | undefined {
  const context: StorageLocal = {};
  if (storage.matchedPath !== undefined && storage.matchedPath !== '') {
    context.matchedPath = storage.matchedPath;
  }
  if (storage.matchedLine !== undefined) {
    context.matchedLine = storage.matchedLine;
  }
  return Object.keys(context).length === 0 ? undefined : context;
}

/** The Storage local record a verdict keeps, dropping `reasons` first if it exceeds the byte cap. */
function keptStorage(storage: StorageLocal | undefined): StorageLocal | undefined {
  if (storage === undefined) return undefined;
  if (withinByteCap(storage)) return storage;
  if (storage.reasons === undefined) return undefined;
  const { reasons: _reasons, ...withoutReasons } = storage;
  if (Object.keys(withoutReasons).length === 0) return undefined;
  return withinByteCap(withoutReasons) ? withoutReasons : undefined;
}

/**
 * An evaluation as a verdict: unevaluated when it needed data, else flagged as
 * drift when it disagrees with production. An unevaluated verdict keeps the
 * rule the simulation evaluated with the data missing, which is context for
 * the gap and not a deciding rule.
 */
export function verdictOf(call: ObservedCall, evaluation: Evaluation): LocalVerdict {
  if (evaluation.needs.length > 0) {
    const unevaluated: Unevaluated = { result: 'unevaluated', needs: evaluation.needs };
    if (evaluation.rule !== undefined) unevaluated.rule = evaluation.rule;
    if (evaluation.rtdb !== undefined) {
      const context = keptRtdb(unevaluatedRtdbOf(evaluation.rtdb));
      if (context !== undefined) unevaluated.rtdb = context;
    }
    if (evaluation.storage !== undefined) {
      const context = keptStorage(unevaluatedStorageOf(evaluation.storage));
      if (context !== undefined) unevaluated.storage = context;
    }
    return unevaluated;
  }
  const { allowed, rule } = evaluation;
  const production = productionVerdict(call.outcome);
  const disagrees = (production === 'ok' && !allowed) || (production === 'denied' && allowed);
  const trace = keptTrace(evaluation.trace);
  const rtdb = keptRtdb(evaluation.rtdb);
  const storage = keptStorage(evaluation.storage);
  const verdict: Decided = { result: allowed ? 'allow' : 'deny' };
  if (rule !== undefined) verdict.rule = rule;
  if (disagrees) verdict.drift = true;
  if (trace !== undefined) verdict.trace = trace;
  if (rtdb !== undefined) verdict.rtdb = rtdb;
  if (storage !== undefined) verdict.storage = storage;
  return verdict;
}

/** `request.auth` for the call: its uid, and its token's claims when the call carries their values. */
export function authOf(call: ObservedCall): { uid: string; token: Record<string, unknown> } | null {
  const account = call.account;
  if (account === undefined) return null;
  const uid = account.uid;
  return { uid, token: { ...account.claims, sub: uid } };
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
