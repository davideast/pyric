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
  ObservedCall,
  ObservedCallService,
  ProductionOutcome,
} from '../types/observed-call.js';
import type { RulesDisposition, SandboxOperationEvent } from '../types/events.js';
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

const SERVICES: ReadonlySet<ObservedCallService> = new Set(['firestore', 'auth']);
const CALL_FIELDS = new Set(['service', 'method', 'path', 'at', 'durationMs', 'outcome', 'account', 'projectId']);
const ACCOUNT_FIELDS = new Set(['uid', 'claimNames']);
/** SDK function names: `getDoc`, `onSnapshot`, `signInWithEmailAndPassword`. */
const METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
/** Firebase error codes, with or without a service prefix: `permission-denied`, `auth/user-not-found`. */
const CODE_PATTERN = /^[a-z0-9_/-]{1,100}$/i;
/** Firebase project ids: lowercase letters, digits and hyphens, as Google Cloud names them. */
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
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
  if (value.path !== undefined) {
    requireField(isBoundedString(value.path, MAX_PATH_LENGTH), 'path');
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
  return call;
}

/**
 * The event an observed call becomes. Its `result` is `error` when production
 * returned an error and `not-applicable` otherwise, since no local Rules
 * verdict exists; `production` holds what production answered.
 */
export function observedCallEvent(call: ObservedCall): SandboxOperationEvent {
  const account = call.account;
  const claimNames = account?.claimNames;
  return makeSandboxOperationEvent({
    at: call.at,
    service: call.service,
    method: call.method,
    ...(call.path === undefined ? {} : { path: call.path }),
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
