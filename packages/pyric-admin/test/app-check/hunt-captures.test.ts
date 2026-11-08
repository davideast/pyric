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

let seq = 0;
function target(): OptionTarget {
  seq += 1;
  const app = initializeApp({ sandbox: initializeSandbox(), projectId: 'demo-hunt' } as Parameters<typeof initializeApp>[0], `hunt-captures-${seq}`);
  const appCheck = getAppCheck(app) as unknown as AppCheck;
  return { appCheck, appId: APP_ID, runJti: `pyric-replay-jti-${seq}`, secrets: { appId: APP_ID, apiKey: '', projectNumber: '', values: [] } };
}

const validationPins: Pin[] = [];

const limitedUsePins: Pin[] = [];

const fractionalPins: Pin[] = [];

const sameJtiPins: Pin[] = [];

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
