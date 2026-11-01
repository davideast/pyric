/**
 * The behavior blocks of the `app-check-admin-options-` captures, built from
 * any object with firebase-admin's createToken and verifyToken. The capture
 * runner passes firebase-admin's App Check; the pyric-admin replay passes
 * pyric-admin's, so both sides are described by the same code.
 *
 * Tokens are recorded by shape only. Every minted token is added to
 * `secrets.values`, so the observation writer refuses a file that still
 * contains one.
 */
import type { AppCheck, AppCheckToken, AppCheckTokenOptions } from 'firebase-admin/app-check';
import { FRACTIONAL_TTL_CASES, validationCases, type ValidationCase } from './admin-option-cases.ts';
import { mintWithRetry } from './mint.ts';
import { redactText, type Secrets } from './redact.ts';

export interface OptionTarget {
  appCheck: AppCheck;
  appId: string;
  runJti: string;
  secrets: Secrets;
}

type Refusal = { mode: 'sync-throw' | 'rejected'; code: string | null; message: string };
type Settled<T> = Refusal | { mode: 'resolved'; value: T };

export interface SameJtiPair {
  first: Settled<AppCheckToken>;
  second: Settled<AppCheckToken>;
}

function refusal(mode: Refusal['mode'], error: unknown, secrets: Secrets): Refusal {
  const e = error as { code?: string; message?: string };
  return { mode, code: e.code ?? null, message: redactText(String(e.message ?? error), secrets) };
}

/** Calls `operation` and reports whether it threw synchronously, rejected, or resolved. */
async function settle<T>(operation: () => Promise<T>, secrets: Secrets): Promise<Settled<T>> {
  let pending: Promise<T>;
  try {
    pending = operation();
  } catch (error) {
    return refusal('sync-throw', error, secrets);
  }
  try {
    return { mode: 'resolved', value: await pending };
  } catch (error) {
    return refusal('rejected', error, secrets);
  }
}

function payloadClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** A minted token reduced to its ttl facts; the token itself is remembered as a secret, never returned. */
function describeToken(settled: Settled<AppCheckToken>, target: OptionTarget) {
  if (settled.mode !== 'resolved') return settled;
  const { token, ttlMillis } = settled.value;
  target.secrets.values.push(token);
  const claims = payloadClaims(token);
  return {
    mode: settled.mode,
    ttlMillis,
    expMinusIat: Number(claims.exp) - Number(claims.iat),
    claimNames: Object.keys(claims).sort(),
    jtiEqualsRequested: claims.jti === target.runJti,
  };
}

function sendValidationCase(target: OptionTarget, testCase: ValidationCase): Promise<AppCheckToken> {
  const appId = testCase.appId === 'empty' ? '' : target.appId;
  return target.appCheck.createToken(appId, testCase.options as AppCheckTokenOptions | undefined);
}

async function validationBehavior(target: OptionTarget) {
  const out: Record<string, unknown> = {};
  for (const testCase of validationCases(target.runJti)) {
    out[testCase.key] = describeToken(await settle(() => sendValidationCase(target, testCase), target.secrets), target);
  }
  return out;
}

async function fractionalTtlBehavior(target: OptionTarget) {
  const out: Record<string, unknown> = {};
  for (const { key, ttlMillis } of FRACTIONAL_TTL_CASES) {
    const settled = await settle(() => mintWithRetry(target.appCheck, target.appId, { ttlMillis }), target.secrets);
    out[key] = { requestedTtlMillis: ttlMillis, ...describeToken(settled, target) };
  }
  return out;
}

async function mintLimitedUse(target: OptionTarget, withJti: boolean): Promise<Settled<AppCheckToken>> {
  const options: AppCheckTokenOptions = withJti ? { limitedUse: true, jti: target.runJti } : { limitedUse: true };
  const settled = await settle(() => mintWithRetry(target.appCheck, target.appId, options), target.secrets);
  if (settled.mode === 'resolved') target.secrets.values.push(settled.value.token);
  return settled;
}

/** Two limitedUse tokens minted with the run jti, shared by both captures. */
export async function mintSameJtiPair(target: OptionTarget): Promise<SameJtiPair> {
  return { first: await mintLimitedUse(target, true), second: await mintLimitedUse(target, true) };
}

/** Behavior of `app-check-admin-options-create-token`. */
export async function createTokenBehavior(target: OptionTarget, pair: SameJtiPair): Promise<Record<string, unknown>> {
  const validation = await validationBehavior(target);
  const limitedUseNoJti = describeToken(await mintLimitedUse(target, false), target);
  const fractionalTtl = await fractionalTtlBehavior(target);
  return {
    validation,
    limitedUse: { noJti: limitedUseNoJti, withJti: describeToken(pair.first, target) },
    fractionalTtl,
  };
}

function describeConsume(settled: Settled<{ alreadyConsumed?: boolean }>) {
  if (settled.mode !== 'resolved') return settled;
  return { mode: settled.mode, keyOrder: Object.keys(settled.value), alreadyConsumed: settled.value.alreadyConsumed };
}

function consume(target: OptionTarget, token: string) {
  return settle(() => target.appCheck.verifyToken(token, { consume: true }), target.secrets);
}

/** Behavior of `app-check-admin-options-same-jti-consume`. */
export async function sameJtiConsumeBehavior(target: OptionTarget, pair: SameJtiPair): Promise<Record<string, unknown>> {
  if (pair.first.mode !== 'resolved' || pair.second.mode !== 'resolved') {
    throw new Error('a limitedUse createToken with the run jti did not resolve; nothing to consume');
  }
  const first = pair.first.value.token;
  const second = pair.second.value.token;
  return {
    sameTokens: first === second,
    consume: {
      first: describeConsume(await consume(target, first)),
      secondSameJti: describeConsume(await consume(target, second)),
      firstAgain: describeConsume(await consume(target, first)),
    },
  };
}
