/**
 * Observed calls: what a client reports production answered, read once and
 * turned into the event every traffic view already reads.
 *
 * A record comes from a client connection, so it is untrusted input. The
 * reader refuses anything that is not exactly an {@link ObservedCall}: an
 * unknown field, a wrong type, an over-long string, or a token value where
 * claim names belong. A record never names its own caller or event id; the
 * host stamps the caller from the connection and the sandbox mints the id.
 * Claim values, written data and a returned document are bounded JSON the
 * host holds in memory for the local rules: one that is malformed or too
 * large is dropped and the call is kept, and the event holds none of them.
 */
import type {
  ObservedAccount,
  ObservedAi,
  ObservedAiUsage,
  ObservedCall,
  ObservedCallService,
  ObservedRequest,
  ObservedRequestApi,
  ObservedUsage,
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

const SERVICES: ReadonlySet<ObservedCallService> = new Set(['firestore', 'auth', 'rtdb', 'ai', 'storage', 'messaging']);
const CALL_FIELDS = new Set([
  'service',
  'method',
  'path',
  'at',
  'durationMs',
  'outcome',
  'account',
  'projectId',
  'instance',
  'bucket',
  'billedDocuments',
  'usage',
  'ai',
  'requests',
  'writeData',
  'document',
]);
const ACCOUNT_FIELDS = new Set(['uid', 'claimNames', 'claims']);
/** A token's claims fit in a few kilobytes; production caps custom claims at 1000 bytes. */
const MAX_CLAIMS_SIZE = 8 * 1024;
/** Written data or a returned document the host holds in memory for one evaluation. */
const MAX_FIELDS_SIZE = 64 * 1024;
/** Firestore nests maps and arrays at most 20 levels deep. */
const MAX_VALUE_DEPTH = 20;
const AI_FIELDS = new Set(['model', 'reportedModel', 'usage', 'firstChunkMs']);
/** Production's sizes: counts only, so a value, a document or a payload has no key to ride in. */
const USAGE_FIELDS: ReadonlySet<keyof ObservedUsage> = new Set([
  'documentReads',
  'documentWrites',
  'documentDeletes',
  'payloadBytes',
  'uploadedBytes',
  'downloadedBytes',
  'unmeasured',
]);
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
/** Bare Cloud Storage bucket names, never a `gs://` URL: `my-project.firebasestorage.app`. */
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;
/**
 * The Storage codes production denies with, as the SDK maps them: Rules
 * denial (403) and App Check rejection (401).
 */
const STORAGE_DENIED_CODES: ReadonlySet<string> = new Set(['storage/unauthorized', 'storage/unauthorized-app']);
const REQUEST_FIELDS = new Set(['api', 'action', 'status']);
/** What each API's requests do: Installations mints an installation and its auth token; registrations hold the FCM token. */
const REQUEST_ACTIONS: ReadonlyMap<ObservedRequestApi, ReadonlySet<string>> = new Map<ObservedRequestApi, ReadonlySet<string>>([
  ['installations', new Set(['create', 'generateAuthToken'])],
  ['registrations', new Set(['create', 'update', 'delete'])],
]);
const MAX_REQUESTS = 4;
const MAX_PATH_LENGTH = 1500;
/** The token walk's bounds: a well-formed call nests three levels deep and its longest list is its claim names. */
const MAX_RECORD_DEPTH = 4;
const MAX_WALKED_ENTRIES = 64;
const MAX_WALKED_STRING_LENGTH = MAX_PATH_LENGTH;
/** Fields the token walk skips because their own reader bounds them: an Auth uid may be a long hex id. */
const UNWALKED_FIELDS: ReadonlySet<string> = new Set(['account.uid']);
/** Splits a string into runs of URL-safe characters and colons, the alphabet every token shape is drawn from. */
const NON_TOKEN_CHARACTERS = /[^A-Za-z0-9_:-]+/;
const DIGIT = /[0-9]/;
/** A JWT's header (`eyJ`) followed by at least this many URL-safe characters. */
const MIN_JWT_TAIL = 10;
/** An FCM registration token: `<id>:APA91b...`, an id of at least 8 characters and a tail of at least 20. */
const MIN_FCM_ID = 8;
const MIN_FCM_TAIL = 20;
/** An opaque key or token, such as a VAPID key or a refresh token: a run this long that holds a digit. */
const MIN_OPAQUE_RUN = 40;
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

/** Whether a value is an object a client built from a literal, not a Date, a Map or a class instance. */
function isPlainFields(value: unknown): value is Fields {
  if (!isFields(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A copy of one JSON value, or `undefined` when it is not one or pushes `budget` past its size. */
function copyJsonValue(value: unknown, depth: number, budget: { left: number }): unknown {
  const isScalar = value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
  if (isScalar) {
    budget.left -= 8;
    return value;
  }
  if (typeof value === 'string') {
    budget.left -= value.length + 2;
    return value;
  }
  const isNested = Array.isArray(value) || isPlainFields(value);
  if (!isNested || depth >= MAX_VALUE_DEPTH) return undefined;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    for (const entry of value) {
      const copied = copyJsonValue(entry, depth + 1, budget);
      if (copied === undefined || budget.left < 0) return undefined;
      copy.push(copied);
    }
    return copy;
  }
  return copyJsonFields(value, depth, budget);
}

function copyJsonFields(value: Fields, depth: number, budget: { left: number }): Fields | undefined {
  const copy: Fields = {};
  for (const key of Object.keys(value)) {
    budget.left -= key.length + 4;
    const copied = copyJsonValue(value[key], depth + 1, budget);
    if (copied === undefined || budget.left < 0) return undefined;
    copy[key] = copied;
  }
  return copy;
}

/**
 * A fresh copy of a JSON object a client sent (claim values, written data,
 * a returned document), or `undefined` for one that is malformed, nested
 * deeper than Firestore allows, or larger than `maxSize`. The reader drops
 * such a value rather than the call: the call still records production's answer.
 */
function readJsonFields(value: unknown, maxSize: number): Fields | undefined {
  if (!isPlainFields(value)) return undefined;
  return copyJsonFields(value, 0, { left: maxSize });
}

function readAccount(value: unknown, keepsClaims: boolean): ObservedAccount {
  requireField(isFields(value), 'account');
  requireOnly(value, ACCOUNT_FIELDS, 'account.');
  const uid = value.uid;
  requireField(isBoundedString(uid, MAX_UID_LENGTH), 'account.uid');
  const account: ObservedAccount = { uid };
  if (value.claimNames !== undefined) account.claimNames = readClaimNames(value.claimNames);
  const claims = keepsClaims ? readJsonFields(value.claims, MAX_CLAIMS_SIZE) : undefined;
  if (claims !== undefined) account.claims = claims;
  return account;
}

/**
 * A Messaging call's record without its claim values. No Messaging rule
 * reads them, and a token's nested claims would trip the walk that keeps
 * credentials out of a Messaging record.
 */
function withoutClaimValues(value: Fields): Fields {
  const account = value.account;
  if (!isFields(account) || account.claims === undefined) return value;
  const { claims: _claims, ...rest } = account;
  return { ...value, account: rest };
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

/** A call's usage: each known count a non-negative safe integer, and any other key refused. */
function readUsage(value: unknown): ObservedUsage {
  requireField(isFields(value), 'usage');
  requireOnly(value, USAGE_FIELDS as ReadonlySet<string>, 'usage.');
  const usage: ObservedUsage = {};
  for (const key of USAGE_FIELDS) {
    const count = value[key];
    if (count === undefined) continue;
    requireField(isDocumentCount(count), `usage.${key}`);
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
 * Whether one colon-free run of URL-safe characters is a JWT's start or an
 * opaque key. The earliest `eyJ` leaves the longest tail, so one search is enough.
 */
function isTokenSegment(segment: string): boolean {
  const jwtStart = segment.indexOf('eyJ');
  const isJwt = jwtStart >= 0 && segment.length - jwtStart - 3 >= MIN_JWT_TAIL;
  const isOpaque = segment.length >= MIN_OPAQUE_RUN && DIGIT.test(segment);
  return isJwt || isOpaque;
}

/** Whether a run of URL-safe characters and colons holds a token: a token segment, or an FCM token across a colon. */
function isTokenRun(run: string): boolean {
  const segments = run.split(':');
  return segments.some((segment, index) => {
    const next = segments[index + 1];
    const isFcmToken = next !== undefined && segment.length >= MIN_FCM_ID && next.length >= MIN_FCM_TAIL;
    return isFcmToken || isTokenSegment(segment);
  });
}

/**
 * Whether a string is shaped like a credential a Messaging call handles: a JWT
 * such as a FIS auth token, an FCM registration token, or another opaque key.
 * It splits once and checks each run by length, so it runs in linear time.
 */
function isTokenShaped(value: string): boolean {
  return value.split(NON_TOKEN_CHARACTERS).some(isTokenRun);
}

/** Refuse a string too long for any field, or one shaped like a token. */
function requireNoTokenString(value: string, field: string): void {
  requireField(value.length <= MAX_WALKED_STRING_LENGTH && !isTokenShaped(value), field);
}

/**
 * Refuse a token-shaped key or value anywhere in `value`, naming the field it
 * sits in. The walk is bounded before any string is checked: strings no longer
 * than the longest field the reader takes, at most 64 entries in a list or
 * object, and at most four levels, which also stops a structured-clone cycle.
 */
function requireNoTokens(value: unknown, field: string, depth = 0): void {
  if (UNWALKED_FIELDS.has(field)) return;
  if (typeof value === 'string') {
    requireNoTokenString(value, field);
    return;
  }
  const isNested = Array.isArray(value) || isFields(value);
  if (!isNested) return;
  const container = field === '' ? 'call' : field;
  requireField(depth < MAX_RECORD_DEPTH, container);
  if (Array.isArray(value)) {
    requireField(value.length <= MAX_WALKED_ENTRIES, container);
    for (const entry of value) requireNoTokens(entry, field, depth + 1);
    return;
  }
  const keys = Object.keys(value);
  requireField(keys.length <= MAX_WALKED_ENTRIES, container);
  for (const key of keys) {
    requireNoTokenString(key, container);
    requireNoTokens((value as Fields)[key], field === '' ? key : `${field}.${key}`, depth + 1);
  }
}

function isHttpStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;
}

function readRequest(value: unknown): ObservedRequest {
  requireField(isFields(value), 'requests');
  requireOnly(value, REQUEST_FIELDS, 'requests.');
  const api = value.api;
  const actions = typeof api === 'string' ? REQUEST_ACTIONS.get(api as ObservedRequestApi) : undefined;
  requireField(actions !== undefined, 'requests.api');
  const action = value.action;
  requireField(typeof action === 'string' && actions.has(action), 'requests.action');
  const request: ObservedRequest = { api: api as ObservedRequestApi, action: action as ObservedRequest['action'] };
  if (value.status !== undefined) {
    requireField(isHttpStatus(value.status), 'requests.status');
    request.status = value.status;
  }
  return request;
}

/** A Messaging call's requests: at most four, each an api, an action and a status. */
function readRequests(value: unknown): ObservedRequest[] {
  requireField(Array.isArray(value) && value.length <= MAX_REQUESTS, 'requests');
  return value.map(readRequest);
}

/**
 * Read one observed call from untrusted input. Returns a fresh record that
 * holds only the known fields; throws {@link ObservedCallError} otherwise.
 */
export function readObservedCall(input: unknown): ObservedCall {
  requireField(isFields(input), 'call');
  // A Messaging call handles an installation's tokens and the FCM token, so
  // nothing in its record may look like one, a field the reader drops included.
  const isMessaging = input.service === 'messaging';
  const value = isMessaging ? withoutClaimValues(input) : input;
  if (isMessaging) requireNoTokens(value, '');
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
    // A Messaging call names no path: its token is not a place.
    requireField(!isAi && !isMessaging && isBoundedString(value.path, MAX_PATH_LENGTH), 'path');
    call.path = value.path;
  }
  if (value.durationMs !== undefined) {
    requireField(isTime(value.durationMs), 'durationMs');
    call.durationMs = value.durationMs;
  }
  if (value.account !== undefined) call.account = readAccount(value.account, !isMessaging);
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
  // A Storage call always names its bucket, so a second bucket's rows never
  // read as the default's. No other call names one.
  const isStorage = call.service === 'storage';
  if (isStorage || value.bucket !== undefined) {
    const isBucket = isStorage && typeof value.bucket === 'string' && BUCKET_PATTERN.test(value.bucket);
    requireField(isBucket, 'bucket');
    call.bucket = value.bucket as string;
  }
  if (value.billedDocuments !== undefined) {
    requireField(isDocumentCount(value.billedDocuments), 'billedDocuments');
    call.billedDocuments = value.billedDocuments;
  }
  if (value.usage !== undefined) call.usage = readUsage(value.usage);
  // An AI call always names its model; no other call carries AI fields.
  if (isAi || value.ai !== undefined) {
    requireField(isAi, 'ai');
    call.ai = readAi(value.ai);
  }
  // Only a Messaging call carries the requests it made.
  if (value.requests !== undefined) {
    requireField(isMessaging, 'requests');
    call.requests = readRequests(value.requests);
  }
  // Only a Firestore call's rules read written data or a stored document.
  const isFirestore = call.service === 'firestore';
  const writeData = isFirestore ? readJsonFields(value.writeData, MAX_FIELDS_SIZE) : undefined;
  if (writeData !== undefined) call.writeData = writeData;
  const returned = isFirestore ? readJsonFields(value.document, MAX_FIELDS_SIZE) : undefined;
  if (returned !== undefined) call.document = returned;
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
 * The event an observed call becomes. Its `result` reads production's answer
 * as the sandbox's own events read theirs: `allow` for a success, `deny` for a
 * denial ({@link productionVerdict}), and `error` otherwise. Its Rules
 * disposition stays {@link OBSERVED_DISPOSITION}, since pyric's Rules did not
 * decide; `production` holds what production answered. An `ai` call's
 * path is its model, and its `observation` holds the model and token counts.
 * A `storage` call's bucket is its `detail.bucket`, and a `messaging` call's
 * requests are its `detail.requests`.
 */
export function observedCallEvent(call: ObservedCall): SandboxOperationEvent {
  const event = observedOperationEvent(call);
  const ai = call.ai;
  return ai === undefined ? event : { ...event, observation: aiObservation(event.id, call, ai) };
}

/**
 * A Storage call's bucket, under the key the sandbox's own Storage events use,
 * and a Messaging call's requests, each copied.
 */
function eventDetail(call: ObservedCall): { detail?: { bucket: string } | { requests: ObservedRequest[] } } {
  const bucket = call.bucket;
  if (bucket !== undefined) return { detail: { bucket } };
  const requests = call.requests;
  return requests === undefined ? {} : { detail: { requests: requests.map((request) => ({ ...request })) } };
}

/** Production's sizes, copied onto the event's production side when the call carried them. */
function productionSizes(call: ObservedCall): { usage?: ObservedUsage; billedDocuments?: number } {
  const usage = call.usage;
  const billedDocuments = call.billedDocuments;
  return {
    ...(usage === undefined ? {} : { usage: { ...usage } }),
    ...(billedDocuments === undefined ? {} : { billedDocuments }),
  };
}

/** The result each verdict reads as, the way the sandbox's own events read. */
const RESULT_BY_VERDICT: Readonly<Record<ProductionVerdict, SandboxOperationEvent['result']>> = {
  ok: 'allow',
  denied: 'deny',
  failed: 'error',
};

/** Production's answer as an event's result: allowed, denied, or an error. */
function observedResult(outcome: ProductionOutcome): SandboxOperationEvent['result'] {
  return RESULT_BY_VERDICT[productionVerdict(outcome)];
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
    ...eventDetail(call),
    auth: account === undefined ? null : { uid: account.uid },
    result: observedResult(call.outcome),
    origin: 'user',
    ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
    rulesDisposition: OBSERVED_DISPOSITION,
    production: {
      outcome: { ...call.outcome },
      ...(claimNames === undefined ? {} : { claimNames: [...claimNames] }),
      ...productionSizes(call),
    },
  });
}

/** Whether a Rules disposition marks a call production served and pyric only observed. */
export function isProductionServed(rules: RulesDisposition | undefined): boolean {
  return rules?.kind === 'not-evaluated' && rules.reason === 'external-execution';
}

/** How every traffic view reads production's answer. */
export type ProductionVerdict = 'ok' | 'denied' | 'failed';

/**
 * Production's answer as a view reads it: `permission-denied`, in any
 * service's spelling, is denied, and so are Storage's `storage/unauthorized`
 * (a Rules denial) and `storage/unauthorized-app` (an App Check rejection,
 * read as denied like Firestore's).
 */
export function productionVerdict(outcome: ProductionOutcome): ProductionVerdict {
  if (outcome.status === 'ok') return 'ok';
  const code = outcome.code.toLowerCase();
  const isPermissionDenied = code === 'permission-denied' || code === 'permission_denied' || code.endsWith('/permission-denied');
  const isDenied = isPermissionDenied || STORAGE_DENIED_CODES.has(code);
  return isDenied ? 'denied' : 'failed';
}
