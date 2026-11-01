/**
 * Replays the App Check and AI Logic hunt's firebase-admin captures through
 * pyric-admin. The behavior blocks come from the same code the capture ran
 * (src/capture/app-check/admin-option-behavior.ts), here with pyric-admin's
 * App Check in place of firebase-admin's.
 *
 * Each key pyric gets wrong is pinned under its finding with both answers
 * (replay-comparison.ts): the test stays green today and fails when either
 * side moves. The fix for a finding deletes its pin.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppCheck } from 'firebase-admin/app-check';
import { initializeSandbox } from 'pyric/sandbox';
import {
  createTokenBehavior,
  mintSameJtiPair,
  sameJtiConsumeBehavior,
  type OptionTarget,
} from '../../../conformance/src/capture/app-check/admin-option-behavior.ts';
import { replayMismatches, type Behavior, type Pin } from '../../../conformance/src/capture/sdk-scenarios/replay-comparison.ts';
import { initializeApp } from '../../src/app/index.js';
import { getAppCheck } from '../../src/app-check/index.js';

const OBS_DIR = join(import.meta.dir, '..', '..', '..', 'conformance', 'observations', 'app-check-admin');
const APP_ID = '1:123456789012:web:0a1b2c3d4e5f60718293a4';

/** The committed capture's behavior block. */
function obs(name: string): Behavior {
  const observation = JSON.parse(readFileSync(join(OBS_DIR, `${name}.json`), 'utf8')) as { behavior: Behavior };
  return observation.behavior;
}

const CLAIM_NAMES = ['aud', 'exp', 'iat', 'iss', 'jti', 'provider', 'sub'];
/** A token pyric mints with its default one hour lifetime. */
const PYRIC_HOUR_TOKEN = { mode: 'resolved', ttlMillis: 3_600_000, expMinusIat: 3600, claimNames: CLAIM_NAMES, jtiEqualsRequested: false };
const RANGE_MESSAGE = 'ttlMillis must be a duration in milliseconds between 30 minutes and 7 days (inclusive).';
const DURATION_MESSAGE = 'ttlMillis must be a duration in milliseconds.';
const OPTIONS_MESSAGE = 'AppCheckTokenOptions must be a non-null object.';
const INVALID = 'app-check/invalid-argument';
const refusal = (mode: string, message: string) => ({ mode, code: INVALID, message });

let seq = 0;
function target(): OptionTarget {
  seq += 1;
  const app = initializeApp({ sandbox: initializeSandbox(), projectId: 'demo-hunt' } as Parameters<typeof initializeApp>[0], `hunt-captures-${seq}`);
  const appCheck = getAppCheck(app) as unknown as AppCheck;
  return { appCheck, appId: APP_ID, runJti: `pyric-replay-jti-${seq}`, secrets: { appId: APP_ID, apiKey: '', projectNumber: '', values: [] } };
}

const validationPins: Pin[] = [
  { key: 'optionsNull', finding: 'AC-2', production: refusal('sync-throw', OPTIONS_MESSAGE), pyric: PYRIC_HOUR_TOKEN },
  { key: 'optionsString', finding: 'AC-2', production: refusal('sync-throw', OPTIONS_MESSAGE), pyric: PYRIC_HOUR_TOKEN },
  { key: 'optionsArray', finding: 'AC-2', production: refusal('sync-throw', OPTIONS_MESSAGE), pyric: PYRIC_HOUR_TOKEN },
  { key: 'ttlNull', finding: 'AC-2', production: refusal('sync-throw', DURATION_MESSAGE), pyric: PYRIC_HOUR_TOKEN },
  { key: 'ttlNaN', finding: 'AC-3, AC-4', production: refusal('sync-throw', DURATION_MESSAGE), pyric: refusal('rejected', RANGE_MESSAGE) },
  { key: 'ttlString', finding: 'AC-3, AC-4', production: refusal('sync-throw', DURATION_MESSAGE), pyric: refusal('rejected', RANGE_MESSAGE) },
  { key: 'ttlTooShort', finding: 'AC-4', production: refusal('sync-throw', RANGE_MESSAGE), pyric: refusal('rejected', RANGE_MESSAGE) },
  {
    key: 'appIdEmpty',
    finding: 'AC-4',
    production: refusal('sync-throw', '`appId` must be a non-empty string.'),
    pyric: refusal('rejected', '`appId` must be a non-empty string.'),
  },
  {
    key: 'jtiWithoutLimitedUse',
    finding: 'AC-1c',
    production: refusal('rejected', '`jti` cannot be specified without setting `limitedUse` to `true`.'),
    pyric: PYRIC_HOUR_TOKEN,
  },
  { key: 'limitedUseString', finding: 'AC-1d', production: refusal('rejected', '`limitedUse` must be a boolean value.'), pyric: PYRIC_HOUR_TOKEN },
  { key: 'jtiNumber', finding: 'AC-1e', production: refusal('rejected', '`jti` must be a string value.'), pyric: PYRIC_HOUR_TOKEN },
];

const limitedUseToken = (jtiEqualsRequested: boolean) => ({ mode: 'resolved', ttlMillis: 300_000, expMinusIat: 300, claimNames: CLAIM_NAMES, jtiEqualsRequested });
const limitedUsePins: Pin[] = [
  { key: 'noJti', finding: 'AC-1f', production: limitedUseToken(false), pyric: PYRIC_HOUR_TOKEN },
  { key: 'withJti', finding: 'AC-1, AC-1f', production: limitedUseToken(true), pyric: PYRIC_HOUR_TOKEN },
];

const fractional = (requested: number, ttlMillis: number, expMinusIat: number) => ({
  requestedTtlMillis: requested,
  mode: 'resolved',
  ttlMillis,
  expMinusIat,
  claimNames: CLAIM_NAMES,
  jtiEqualsRequested: false,
});
const fractionalPins: Pin[] = [
  { key: 'ttl1800999', finding: 'AC-5', production: fractional(1_800_999, 1_800_999, 1801), pyric: fractional(1_800_999, 1_800_999, 1800) },
  { key: 'ttl1800000point5', finding: 'AC-5', production: fractional(1_800_000.5, 1_800_000, 1800), pyric: fractional(1_800_000.5, 1_800_000.5, 1800) },
];

const PRODUCTION_KEY_ORDER = ['alreadyConsumed', 'appId', 'token'];
const PYRIC_KEY_ORDER = ['appId', 'token', 'alreadyConsumed'];
const consumed = (keyOrder: string[], alreadyConsumed: boolean) => ({ mode: 'resolved', keyOrder, alreadyConsumed });
const sameJtiPins: Pin[] = [
  { key: 'sameTokens', finding: 'AC-1', production: true, pyric: false },
  { key: 'first', finding: 'AC-12', production: consumed(PRODUCTION_KEY_ORDER, false), pyric: consumed(PYRIC_KEY_ORDER, false) },
  { key: 'secondSameJti', finding: 'AC-1, AC-12', production: consumed(PRODUCTION_KEY_ORDER, true), pyric: consumed(PYRIC_KEY_ORDER, false) },
  { key: 'firstAgain', finding: 'AC-12', production: consumed(PRODUCTION_KEY_ORDER, true), pyric: consumed(PYRIC_KEY_ORDER, true) },
];

/** `{ sameTokens, consume: { first, ... } }` as one flat block, so each consume result is its own key. */
function flattenConsume(behavior: Behavior): Behavior {
  const { consume, ...rest } = behavior;
  return { ...rest, ...(consume as Behavior) };
}

describe('app-check-admin-options-create-token replay', () => {
  const production = obs('app-check-admin-options-create-token');
  let pyric: Behavior;
  beforeAll(async () => {
    const replayTarget = target();
    pyric = await createTokenBehavior(replayTarget, await mintSameJtiPair(replayTarget));
  });

  test('validation: every malformed option value (AC-1c, AC-1d, AC-1e, AC-2, AC-3, AC-4)', () => {
    expect(replayMismatches({ production: production.validation as Behavior, pyric: pyric.validation as Behavior, pins: validationPins })).toEqual([]);
  });

  test('limitedUse: ttl and the chosen jti (AC-1, AC-1f)', () => {
    expect(replayMismatches({ production: production.limitedUse as Behavior, pyric: pyric.limitedUse as Behavior, pins: limitedUsePins })).toEqual([]);
  });

  test('fractionalTtl: ttlMillis echo and token lifetime (AC-5)', () => {
    expect(replayMismatches({ production: production.fractionalTtl as Behavior, pyric: pyric.fractionalTtl as Behavior, pins: fractionalPins })).toEqual([]);
  });
});

describe('app-check-admin-options-same-jti-consume replay', () => {
  test('two limitedUse tokens with one jti, then consume three times (AC-1, AC-12)', async () => {
    const production = flattenConsume(obs('app-check-admin-options-same-jti-consume'));
    const replayTarget = target();
    const pyric = flattenConsume(await sameJtiConsumeBehavior(replayTarget, await mintSameJtiPair(replayTarget)));
    expect(replayMismatches({ production, pyric, pins: sameJtiPins })).toEqual([]);
  });
});
