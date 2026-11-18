/**
 * Replays the `app-check-admin-options-` firebase-admin captures through
 * `pyric-admin/app-check`. The behavior blocks come from the same code the
 * capture ran (`src/capture/app-check/admin-option-behavior.ts`), asserting
 * zero mismatches across every validation, `limitedUse`, `fractionalTtl`, and
 * `sameJtiConsume` case.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppCheck } from 'firebase-admin/app-check';
import { initializeSandbox, type Sandbox } from 'pyric/sandbox';
import {
  createTokenBehavior,
  mintSameJtiPair,
  sameJtiConsumeBehavior,
  type OptionTarget,
} from '../../../conformance/src/capture/app-check/admin-option-behavior.ts';
import { replayMismatches, type Behavior } from '../../../conformance/src/capture/sdk-scenarios/replay-comparison.ts';
import { deleteApp, initializeApp, type PyricAdminApp } from '../../src/app/index.js';
import { getAppCheck } from '../../src/app-check/index.js';

const OBS_DIR = join(import.meta.dir, '..', '..', '..', 'conformance', 'observations', 'app-check-admin');
const APP_ID = '1:123456789012:web:0a1b2c3d4e5f60718293a4';

/** The committed capture's behavior block. */
function obs(name: string): Behavior {
  const observation = JSON.parse(readFileSync(join(OBS_DIR, `${name}.json`), 'utf8')) as { behavior: Behavior };
  return observation.behavior;
}

const createdApps: PyricAdminApp[] = [];
const createdSandboxes: Sandbox[] = [];

afterAll(async () => {
  await Promise.all(createdApps.map((app) => deleteApp(app).catch(() => undefined)));
  for (const sbx of createdSandboxes) {
    sbx.dispose();
  }
});

let seq = 0;
function target(): OptionTarget {
  seq += 1;
  const sandbox = initializeSandbox();
  createdSandboxes.push(sandbox);
  const app = initializeApp(
    { sandbox, projectId: 'demo-project' } as Parameters<typeof initializeApp>[0],
    `admin-options-${seq}`,
  );
  createdApps.push(app);
  const appCheck = getAppCheck(app) as unknown as AppCheck;
  return {
    appCheck,
    appId: APP_ID,
    runJti: `pyric-replay-jti-${seq}`,
    secrets: { appId: APP_ID, apiKey: '', projectNumber: '', values: [] },
  };
}

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

  test('validation: every malformed option value matches production sync-throw vs rejected', () => {
    expect(
      replayMismatches({
        production: production.validation as Behavior,
        pyric: pyric.validation as Behavior,
        pins: [],
      }),
    ).toEqual([]);
  });

  test('limitedUse: 300s ttl and requested jti claim match production', () => {
    expect(
      replayMismatches({
        production: production.limitedUse as Behavior,
        pyric: pyric.limitedUse as Behavior,
        pins: [],
      }),
    ).toEqual([]);
  });

  test('fractionalTtl: floored ttlMillis echo and rounded JWT lifetime match production', () => {
    expect(
      replayMismatches({
        production: production.fractionalTtl as Behavior,
        pyric: pyric.fractionalTtl as Behavior,
        pins: [],
      }),
    ).toEqual([]);
  });
});

describe('app-check-admin-options-same-jti-consume replay', () => {
  test('two limitedUse tokens with one jti share consumption state and preserve result key order', async () => {
    const production = flattenConsume(obs('app-check-admin-options-same-jti-consume'));
    const replayTarget = target();
    const pyric = flattenConsume(
      await sameJtiConsumeBehavior(replayTarget, await mintSameJtiPair(replayTarget)),
    );
    expect(replayMismatches({ production, pyric, pins: [] })).toEqual([]);
  });
});
