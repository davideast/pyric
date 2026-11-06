/**
 * Observed calls: what a client reports production answered, read once and
 * turned into the event every traffic view already reads.
 *
 * A record comes from a client connection, so it is untrusted input. The
 * reader refuses anything that is not exactly an {@link ObservedCall}: an
 * unknown field, a wrong type, an over-long string, or a token value where
 * claim names belong. A record never names its own caller or event id; the
 * host stamps the caller from the connection and the sandbox mints the id.
 */
import type {
  ObservedAccount,
  ObservedAi,
  ObservedAiUsage,
  ObservedCall,
  ObservedCallService,
  ProductionOutcome,
} from '../types/observed-call.js';
import type { RulesDisposition, SandboxOperationEvent } from '../types/events.js';
import type { RequestObservation } from '../types/request-observation.js';
import { AI_LOGIC_ENDPOINT, aiUsageEvidence, type AiEvidence } from './ai-evidence.js';
import { isDefaultDatabaseInstance } from './instances.js';
import { makeSandboxOperationEvent } from './sandbox-impl.js';

/** Thrown for a record that is not an {@link ObservedCall}; names the field. */
export class ObservedCallError extends Error {
  readonly code = 'invalid-argument';
  constructor(field: string) {
    super(`Invalid observed call field: ${field}.`);
    this.name = 'ObservedCallError';
  }
}

/** The disposition of every observed event: production ran the call, pyric's Rules did not. */
export const OBSERVED_DISPOSITION: RulesDisposition = Object.freeze({
  kind: 'not-evaluated',
  reason: 'external-execution',
});

const SERVICES: ReadonlySet<ObservedCallService> = new Set(['firestore', 'auth', 'rtdb', 'ai']);
const CALL_FIELDS = new Set(['service', 'method', 'path', 'at', 'durationMs', 'outcome', 'account', 'projectId', 'instance', 'billedDocuments', 'ai']);
const ACCOUNT_FIELDS = new Set(['uid', 'claimNames']);
const AI_FIELDS = new Set(['model', 'reportedModel', 'usage', 'firstChunkMs']);
const AI_USAGE_FIELDS: ReadonlySet<keyof ObservedAiUsage> = new Set(['promptTokenCount', 'candidatesTokenCount', 'totalTokenCount', 'totalTokens']);
/** Model resources and versions: `models/gemini-flash-lite-latest`, `gemini-2.5-flash-lite`. */
const MODEL_PATTERN = /^[A-Za-z0-9._/-]{1,200}$/;
/** SDK function names: `getDoc`, `onSnapshot`, `signInWithEmailAndPassword`. */
const METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
/** Firebase error codes, with or without a service prefix: `permission-denied`, `auth/user-not-found`. */
const CODE_PATTERN = /^[a-z0-9_/-]{1,100}$/i;
/** Firebase project ids: lowercase letters, digits and hyphens, as Google Cloud names them. */
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** RTDB instance names, as the SDK's namespace holds them: `my-project-default-rtdb`. */
const INSTANCE_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/;
const MAX_PATH_LENGTH = 1500;
const MAX_UID_LENGTH = 128;
const MAX_CLAIM_NAMES = 64;
const MAX_CLAIM_NAME_LENGTH = 128;

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireField(valid: boolean, field: string): asserts valid {
  if (!valid) throw new ObservedCallError(field);
}

function requireOnly(value: Fields, allowed: ReadonlySet<string>, prefix: string): void {
  for (const key of Object.keys(value)) requireField(allowed.has(key), `${prefix}${key}`);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isDocumentCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function readOutcome(value: unknown): ProductionOutcome {
  requireField(isFields(value), 'outcome');
  if (value.status === 'ok') {
    requireOnly(value, new Set(['status']), 'outcome.');
    return { status: 'ok' };
  }
  requireField(value.status === 'error', 'outcome.status');
  requireOnly(value, new Set(['status', 'code']), 'outcome.');
  const code = value.code;
  requireField(typeof code === 'string' && CODE_PATTERN.test(code), 'outcome.code');
  return { status: 'error', code };
}

function readClaimNames(value: unknown): string[] {
  requireField(Array.isArray(value) && value.length <= MAX_CLAIM_NAMES, 'account.claimNames');
  return value.map((name) => {
    requireField(isBoundedString(name, MAX_CLAIM_NAME_LENGTH), 'account.claimNames');
    return name;
  });
}

function readAccount(value: unknown): ObservedAccount {
  requireField(isFields(value), 'account');
  requireOnly(value, ACCOUNT_FIELDS, 'account.');
  const uid = value.uid;
  requireField(isBoundedString(uid, MAX_UID_LENGTH), 'account.uid');
  const hasClaims = value.claimNames !== undefined;
  return hasClaims ? { uid, claimNames: readClaimNames(value.claimNames) } : { uid };
}

function isModelName(value: unknown): value is string {
  return typeof value === 'string' && MODEL_PATTERN.test(value);
}

function readAiUsage(value: unknown): ObservedAiUsage {
  requireField(isFields(value), 'ai.usage');
  requireOnly(value, AI_USAGE_FIELDS as ReadonlySet<string>, 'ai.usage.');
  const usage: ObservedAiUsage = {};
  for (const key of AI_USAGE_FIELDS) {
    const count = value[key];
    if (count === undefined) continue;
    requireField(isDocumentCount(count), `ai.usage.${key}`);
    usage[key] = count;
  }
  return usage;
}

/** An `ai` call's model and token counts; any other key (text, a response) is refused. */
function readAi(value: unknown): ObservedAi {
  requireField(isFields(value), 'ai');
  requireOnly(value, AI_FIELDS, 'ai.');
  const model = value.model;
  requireField(isModelName(model), 'ai.model');
  const ai: ObservedAi = { model };
  if (value.reportedModel !== undefined) {
    requireField(isModelName(value.reportedModel), 'ai.reportedModel');
    ai.reportedModel = value.reportedModel;
  }
  if (value.usage !== undefined) ai.usage = readAiUsage(value.usage);
  if (value.firstChunkMs !== undefined) {
    requireField(isTime(value.firstChunkMs), 'ai.firstChunkMs');
    ai.firstChunkMs = value.firstChunkMs;
  }
  return ai;
}

/**
 * Read one observed call from untrusted input. Returns a fresh record that
 * holds only the known fields; throws {@link ObservedCallError} otherwise.
 */
export function readObservedCall(value: unknown): ObservedCall {
  requireField(isFields(value), 'call');
  requireOnly(value, CALL_FIELDS, '');
  const service = value.service;
  requireField(typeof service === 'string' && SERVICES.has(service as ObservedCallService), 'service');
  const method = value.method;
  requireField(typeof method === 'string' && METHOD_PATTERN.test(method), 'method');
  requireField(isTime(value.at), 'at');
  const call: ObservedCall = {
    service: service as ObservedCallService,
    method,
    at: value.at,
    outcome: readOutcome(value.outcome),
  };
  const isAi = call.service === 'ai';
  if (value.path !== undefined) {
    // An AI call's path is its model, so a second path could disagree with it.
    requireField(!isAi && isBoundedString(value.path, MAX_PATH_LENGTH), 'path');
    call.path = value.path;
  }
  if (value.durationMs !== undefined) {
    requireField(isTime(value.durationMs), 'durationMs');
    call.durationMs = value.durationMs;
  }
  if (value.account !== undefined) call.account = readAccount(value.account);
  if (value.projectId !== undefined) {
    requireField(typeof value.projectId === 'string' && PROJECT_ID_PATTERN.test(value.projectId), 'projectId');
    call.projectId = value.projectId;
  }
  // An RTDB call always names its instance, the default included, so a
  // named-instance call can never read as the default. No other call names one.
  const isRtdb = call.service === 'rtdb';
  if (isRtdb || value.instance !== undefined) {
    const isRtdbInstance = isRtdb && typeof value.instance === 'string' && INSTANCE_PATTERN.test(value.instance);
    requireField(isRtdbInstance, 'instance');
    call.instance = value.instance as string;
  }
  if (value.billedDocuments !== undefined) {
    requireField(isDocumentCount(value.billedDocuments), 'billedDocuments');
    call.billedDocuments = value.billedDocuments;
  }
  // An AI call always names its model; no other call carries AI fields.
  if (isAi || value.ai !== undefined) {
    requireField(isAi, 'ai');
    call.ai = readAi(value.ai);
  }
  return call;
}

/**
 * The instance the event names: absent for the project's default instance, as
 * the `operation` event's `instance` field documents, and the name otherwise.
 */
function eventInstance(call: ObservedCall): { instance?: string } {
  const instance = call.instance;
  const isUnnamed = instance === undefined || isDefaultDatabaseInstance(instance, call.projectId);
  return isUnnamed ? {} : { instance };
}

/** Drop the keys whose value is undefined, so an event names only what was recorded. */
function definedOnly<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/**
 * The evidence the sandbox's own AI events carry, built from an observed
 * call: production's endpoint, and the tokens through the one shared mapping.
 */
function observedAiEvidence(ai: ObservedAi, durationMs: number | undefined): AiEvidence {
  const usage = ai.usage;
  const hasUsage = usage !== undefined && Object.keys(usage).length > 0;
  // `countTokens` answers `totalTokens`; it counts as the total, as the broker counts it.
  const isCountTokens = usage?.totalTokens !== undefined;
  const counts = isCountTokens ? { ...usage, totalTokenCount: usage.totalTokens } : usage;
  const tokens = aiUsageEvidence(counts, ai.reportedModel);
  return definedOnly<AiEvidence>({
    requestedModel: ai.model,
    reportedModel: tokens.reportedModel,
    engine: 'gemini',
    endpoint: AI_LOGIC_ENDPOINT,
    usageSource: hasUsage ? 'backend' : 'unknown',
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    totalTokens: tokens.totalTokens,
    durationMs,
    firstChunkMs: ai.firstChunkMs,
  });
}

/**
 * The request observation of an AI call, shaped as the sandbox's own AI events
 * shape theirs. It never holds a response.
 */
function aiObservation(id: string, call: ObservedCall, ai: ObservedAi): RequestObservation {
  const outcome = call.outcome;
  const isError = outcome.status === 'error';
  return {
    id,
    startedAt: call.at,
    endedAt: call.at + (call.durationMs ?? 0),
    status: isError ? 'failed' : 'completed',
    ai: observedAiEvidence(ai, call.durationMs),
    ...(isError ? { error: { code: outcome.code } } : {}),
  };
}

/**
 * The event an observed call becomes. Its `result` is `error` when production
 * returned an error and `not-applicable` otherwise, since no local Rules
 * verdict exists; `production` holds what production answered. An `ai` call's
 * path is its model, and its `observation` holds the model and token counts.
 */
export function observedCallEvent(call: ObservedCall): SandboxOperationEvent {
  const event = observedOperationEvent(call);
  const ai = call.ai;
  return ai === undefined ? event : { ...event, observation: aiObservation(event.id, call, ai) };
}

function observedOperationEvent(call: ObservedCall): SandboxOperationEvent {
  const account = call.account;
  const claimNames = account?.claimNames;
  const path = call.ai?.model ?? call.path;
  return makeSandboxOperationEvent({
    at: call.at,
    service: call.service,
    method: call.method,
    ...(path === undefined ? {} : { path }),
    ...eventInstance(call),
    auth: account === undefined ? null : { uid: account.uid },
    result: call.outcome.status === 'error' ? 'error' : 'not-applicable',
    origin: 'user',
    ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
    rulesDisposition: OBSERVED_DISPOSITION,
    production: {
      outcome: { ...call.outcome },
      ...(claimNames === undefined ? {} : { claimNames: [...claimNames] }),
    },
  });
}

/** Whether a Rules disposition marks a call production served and pyric only observed. */
export function isProductionServed(rules: RulesDisposition | undefined): boolean {
  return rules?.kind === 'not-evaluated' && rules.reason === 'external-execution';
}

/** How every traffic view reads production's answer. */
export type ProductionVerdict = 'ok' | 'denied' | 'failed';

/** Production's answer as a view reads it: `permission-denied`, in any service's spelling, is denied. */
export function productionVerdict(outcome: ProductionOutcome): ProductionVerdict {
  if (outcome.status === 'ok') return 'ok';
  const code = outcome.code.toLowerCase();
  const isDenied = code === 'permission-denied' || code === 'permission_denied' || code.endsWith('/permission-denied');
  return isDenied ? 'denied' : 'failed';
}
