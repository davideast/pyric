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
  isSecretObservationKey,
  observationText,
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
type RuleCheck = Trace['rules'][number]['checks'][number];
export type RtdbLocal = LocalRtdbEvaluation;
export type StorageLocal = LocalStorageEvaluation;

/** One method's local answer: allowed or not, the deciding rule, the data it needed, and its evaluation trace. */
export interface Evaluation {
  allowed: boolean;
  rule: Rule;
  needs: Gap[];
  missingPaths?: string[];
  trace?: Trace;
  rtdb?: RtdbLocal;
  storage?: StorageLocal;
}

/** The largest trace, in bytes of JSON, a verdict keeps; a larger one is dropped and the verdict kept. */
const TRACE_LIMIT = 16 * 1024;
/** Maximum uncaptured resource or document paths attached to an unevaluated verdict. */
const MAX_MISSING_PATHS = 16;

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

/** Sorted, deduplicated union of missing path lists. */
export function unionPaths(
  first: readonly string[] | undefined,
  second: readonly string[] | undefined,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of [first, second]) {
    if (list === undefined) continue;
    for (const item of list) {
      if (item !== '' && !seen.has(item)) {
        seen.add(item);
        out.push(item);
      }
    }
  }
  return out.sort();
}

/** The gaps a set of expressions reach that the given data leaves open, each once, in a fixed order. */
export function gapsIn(expressions: ReadonlyArray<string | undefined>, patterns: readonly GapPattern[], given: Given): Gap[] {
  const reaches = (pattern: RegExp) => expressions.some((text) => text !== undefined && pattern.test(text));
  const open = patterns.filter(([, pattern, isOpen]) => isOpen(given) && reaches(pattern)).map(([gap]) => gap);
  return unionOf(open, []);
}

/** What the call carries for an evaluation of `method`. */
export function givenBy(call: ObservedCall, method: ObservedMethod): Given {
  const signedOut = call.account === undefined;
  const hasEmailClaim = call.account?.claims?.email !== undefined;
  const tokenHasNoEmail =
    call.account?.claims !== undefined &&
    call.account.claimNames !== undefined &&
    !call.account.claimNames.includes('email');
  return {
    claims: signedOut || call.account?.claims !== undefined,
    emailKnown: signedOut || hasEmailClaim || tokenHasNoEmail,
    writeData: call.writeData !== undefined,
    document: call.document !== undefined,
    wholeWrite: method === 'create' || method === 'set',
  };
}

/** Drop the keys whose value is undefined. */
export function definedOnly<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

const CLAIMS_CONTAINER_KEY =
  /\[\s*['"]token['"]\s*\]\s*(?=\.\s*(?!(?:lower|upper|trim|split|replace|matches|toUtf8)\s*\()[A-Za-z_$]|\[\s*['"])/g;
const CLAIMS_CONTAINER_PROP =
  /\btoken\b\s*(?=\.\s*(?!(?:lower|upper|trim|split|replace|matches|toUtf8)\s*\()[A-Za-z_$]|\[\s*['"])/g;
const BRACKET_STRING_KEY = /\[\s*['"]([^'"]+)['"]\s*\]/g;
const MAP_GET_STRING_KEY = /\.\s*get\s*\(\s*['"]([^'"]+)['"]/g;
const QUOTED_LITERAL = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g;
const IDENTIFIER_TOKEN = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const HEX_DIGEST_RUN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$|^[0-9a-f]{128}$/i;
const NON_SECRET_TOKEN_KEY =
  /(?:token[-_]?count|tokens[-_]?details|tokens[-_]?valid[-_]?after(?:[-_]?(?:ms|time))?|(?:total|input|output|prompt|candidates|cached|thoughts|tool[-_]?use[-_]?prompt)[-_]?tokens|(?:next[-_]?)?page[-_]?token|(?:(?:issued|subject)[-_]?)?token[-_]?type)$/i;

/** Defines an enumerable own data property without invoking `Object.prototype.__proto__` setters. */
export function defineOwnField<V>(target: Record<string, V>, key: string, value: V): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function isSecretKeyName(key: string): boolean {
  return !NON_SECRET_TOKEN_KEY.test(key) && isSecretObservationKey(key);
}

/** Scrubs bearer headers, JWTs, API keys, OAuth/refresh/FCM tokens, and 40+ char opaque credentials. */
export function scrubSecretText(text: string): string {
  return observationText(text)
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*)?/g, '[redacted token]')
    .replace(/(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{10,}/g, '[redacted token]')
    .replace(/(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g, '[redacted]')
    .replace(/(?<![A-Za-z0-9_-])ya29\.[0-9A-Za-z._-]+/g, '[redacted token]')
    .replace(/(?<![A-Za-z0-9_])1\/\/[0-9A-Za-z._-]{8,}/g, '[redacted token]')
    .replace(/[A-Za-z0-9_-]{8,}:APA91b[A-Za-z0-9_-]{20,}/g, '[redacted token]')
    .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g, (run) => {
      if (run.startsWith('sandbox_') || HEX_DIGEST_RUN.test(run)) return run;
      return /[A-Za-z]/.test(run) && /\d/.test(run) ? '[redacted token]' : run;
    });
}

function checkReferencesSecretKey(check: RuleCheck, secretBindings: ReadonlySet<string>): boolean {
  if (
    check.binding !== undefined &&
    (isSecretKeyName(check.binding) || secretBindings.has(check.binding))
  ) {
    return true;
  }
  const normalized = check.expression
    .replace(CLAIMS_CONTAINER_KEY, '__claims_map__')
    .replace(CLAIMS_CONTAINER_PROP, '__claims_map__');

  for (const pattern of [BRACKET_STRING_KEY, MAP_GET_STRING_KEY]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(normalized)) !== null) {
      if (match[1] !== undefined && isSecretKeyName(match[1])) {
        return true;
      }
    }
  }

  const withoutLiterals = normalized.replace(QUOTED_LITERAL, ' ');
  IDENTIFIER_TOKEN.lastIndex = 0;
  let identMatch: RegExpExecArray | null;
  while ((identMatch = IDENTIFIER_TOKEN.exec(withoutLiterals)) !== null) {
    const ident = identMatch[0];
    if (ident === '__claims_map__') continue;
    if (secretBindings.has(ident) || isSecretKeyName(ident)) {
      return true;
    }
  }
  return false;
}

function hasTaintedCallAncestor(
  checks: readonly RuleCheck[],
  startParent: number | null,
  value: string,
  taintedByCall: ReadonlyMap<number, ReadonlySet<string>>,
): boolean {
  let cursor = startParent;
  const visited = new Set<number>();
  while (cursor !== null && !visited.has(cursor)) {
    visited.add(cursor);
    if (taintedByCall.get(cursor)?.has(value)) return true;
    cursor = checks[cursor]?.parent ?? null;
  }
  return false;
}

function scrubRuleChecks(checks: readonly RuleCheck[]): RuleCheck[] {
  const secretChecks = new Set<number>();
  const secretBindings = new Set<string>();
  const taintedByCall = new Map<number, Set<string>>();

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < checks.length; i++) {
      if (secretChecks.has(i)) continue;
      const check = checks[i]!;
      if (check.kind === 'literal') continue;
      const byKey = checkReferencesSecretKey(check, secretBindings);
      const byCallArg =
        !byKey &&
        check.state === 'value' &&
        typeof check.value === 'string' &&
        check.value !== '' &&
        hasTaintedCallAncestor(checks, check.parent, check.value, taintedByCall);
      if (!byKey && !byCallArg) continue;

      secretChecks.add(i);
      changed = true;
      if (check.binding !== undefined) {
        secretBindings.add(check.binding);
      }
      if (
        check.state === 'value' &&
        typeof check.value === 'string' &&
        check.value !== '' &&
        check.parent !== null &&
        checks[check.parent]?.kind === 'functionCall'
      ) {
        let set = taintedByCall.get(check.parent);
        if (!set) {
          set = new Set<string>();
          taintedByCall.set(check.parent, set);
        }
        set.add(check.value);
      }
    }
  }

  return checks.map((check, idx) => {
    if (check.state === 'error') {
      return { ...check, error: scrubSecretText(check.error) };
    }
    if (check.state === 'value' && typeof check.value === 'string') {
      return {
        ...check,
        value: secretChecks.has(idx) ? '[redacted]' : scrubSecretText(check.value),
      };
    }
    return check;
  });
}

export function scrubLocalRule(rule: Rule): Rule {
  if (rule === undefined) return undefined;
  const out: NonNullable<Rule> = {};
  if (rule.line !== undefined) out.line = rule.line;
  if (rule.expression !== undefined) out.expression = scrubSecretText(rule.expression);
  if (rule.path !== undefined) out.path = scrubSecretText(rule.path);
  return out;
}

export function scrubFirestoreTrace(trace: Trace): Trace {
  return {
    ...trace,
    rules: trace.rules.map((rule) => ({
      ...rule,
      expression: scrubSecretText(rule.expression),
      ...(rule.path !== undefined ? { path: scrubSecretText(rule.path) } : {}),
      ...(rule.error !== undefined ? { error: scrubSecretText(rule.error) } : {}),
      checks: scrubRuleChecks(rule.checks),
    })),
    paths: trace.paths.map((entry) => ({
      ...entry,
      path: scrubSecretText(entry.path),
    })),
    ...(trace.queryProof !== undefined
      ? {
          queryProof: {
            ...trace.queryProof,
            failures: trace.queryProof.failures.map((failure) => ({
              ...failure,
              reason: scrubSecretText(failure.reason),
              ...(failure.expression !== undefined
                ? { expression: scrubSecretText(failure.expression) }
                : {}),
            })),
          },
        }
      : {}),
  };
}

export function scrubRtdbBindings(bindings: Readonly<Record<string, string>>): Record<string, string> {
  const scrubbed: Record<string, string> = {};
  for (const [key, value] of Object.entries(bindings)) {
    const bareKey = key.startsWith('$') ? key.slice(1) : key;
    const cleanValue = isSecretKeyName(bareKey) ? '[redacted]' : scrubSecretText(value);
    defineOwnField(scrubbed, key, cleanValue);
  }
  return scrubbed;
}

export function scrubRtdbLocal(rtdb: RtdbLocal): RtdbLocal {
  const scrubbed: RtdbLocal = {};
  if (rtdb.matchedPath !== undefined) scrubbed.matchedPath = scrubSecretText(rtdb.matchedPath);
  if (rtdb.matchedRule !== undefined) scrubbed.matchedRule = scrubSecretText(rtdb.matchedRule);
  if (rtdb.pathVariableBindings !== undefined) {
    scrubbed.pathVariableBindings = scrubRtdbBindings(rtdb.pathVariableBindings);
  }
  if (rtdb.reason !== undefined) scrubbed.reason = scrubSecretText(rtdb.reason);
  if (rtdb.errorCode !== undefined) scrubbed.errorCode = rtdb.errorCode;
  if (rtdb.rtdbTrace !== undefined) {
    scrubbed.rtdbTrace = rtdb.rtdbTrace.map((entry) => ({
      ...entry,
      path: scrubSecretText(entry.path),
      conditionText: scrubSecretText(entry.conditionText),
      pathVariableBindings: scrubRtdbBindings(entry.pathVariableBindings),
      ...(entry.message !== undefined ? { message: scrubSecretText(entry.message) } : {}),
    }));
  }
  return scrubbed;
}

export function scrubStorageLocal(storage: StorageLocal): StorageLocal {
  const scrubbed: StorageLocal = {};
  if (storage.matchedPath !== undefined) scrubbed.matchedPath = scrubSecretText(storage.matchedPath);
  if (storage.matchedLine !== undefined) scrubbed.matchedLine = storage.matchedLine;
  if (storage.reasons !== undefined) scrubbed.reasons = storage.reasons.map(scrubSecretText);
  return scrubbed;
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

function keptMissingPaths(paths: readonly string[] | undefined): string[] | undefined {
  if (paths === undefined || paths.length === 0) return undefined;
  const bounded = unionPaths(paths.map(scrubSecretText), undefined).slice(0, MAX_MISSING_PATHS);
  if (bounded.length === 0) return undefined;
  if (!withinByteCap(bounded)) return undefined;
  return bounded;
}

/**
 * An evaluation as a verdict: unevaluated when it needed data, else flagged as
 * drift when it disagrees with production. An unevaluated verdict keeps the
 * rule the simulation evaluated with the data missing, which is context for
 * the gap and not a deciding rule.
 */
export function verdictOf(call: ObservedCall, evaluation: Evaluation): LocalVerdict {
  const rule = scrubLocalRule(evaluation.rule);
  if (evaluation.needs.length > 0) {
    const unevaluated: Unevaluated = { result: 'unevaluated', needs: evaluation.needs };
    const missingPaths = keptMissingPaths(evaluation.missingPaths);
    if (missingPaths !== undefined) unevaluated.missingPaths = missingPaths;
    if (rule !== undefined) unevaluated.rule = rule;
    if (evaluation.rtdb !== undefined) {
      const context = keptRtdb(unevaluatedRtdbOf(scrubRtdbLocal(evaluation.rtdb)));
      if (context !== undefined) unevaluated.rtdb = context;
    }
    if (evaluation.storage !== undefined) {
      const context = keptStorage(unevaluatedStorageOf(scrubStorageLocal(evaluation.storage)));
      if (context !== undefined) unevaluated.storage = context;
    }
    return unevaluated;
  }
  const { allowed } = evaluation;
  const production = productionVerdict(call.outcome);
  const disagrees = (production === 'ok' && !allowed) || (production === 'denied' && allowed);
  const trace = keptTrace(evaluation.trace !== undefined ? scrubFirestoreTrace(evaluation.trace) : undefined);
  const rtdb = keptRtdb(evaluation.rtdb !== undefined ? scrubRtdbLocal(evaluation.rtdb) : undefined);
  const storage = keptStorage(evaluation.storage !== undefined ? scrubStorageLocal(evaluation.storage) : undefined);
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
