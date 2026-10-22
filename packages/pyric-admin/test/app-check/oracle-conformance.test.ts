/**
 * Oracle conformance for `pyric-admin/app-check` (surface `app-check-admin`),
 * authored red under Conformance Driven Development (docs/conformance/cdd.md,
 * Step 3). One assertion set per `app-check-admin` row in
 * packages/conformance/registry/app-check.ts, replaying the
 * `app-check-admin-` captures through the observation gate.
 *
 * Blocking run: only expected-green rows run. The climb lane
 * (`PYRIC_CLIMB=1`) runs every row and the prefix completeness gate.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { appCheckRows } from '../../../conformance/registry/app-check.ts';
import { createObservationGate } from '../../../conformance/src/observation-gate.ts';
import { jwtShape, tamperSignature, type Secrets } from '../../../conformance/src/capture/app-check/redact.ts';
import { initializeSandbox } from 'pyric/sandbox';
import { mintAppCheckToken } from 'pyric/sandbox/internal';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getAppCheck } from '../../src/app-check/index.js';

const isClimb = process.env.PYRIC_CLIMB === '1';
const OBS_DIR = join(import.meta.dir, '..', '..', '..', 'conformance', 'observations', 'app-check-admin');
const gate = createObservationGate({ dir: OBS_DIR, match: (file) => file.startsWith('app-check-admin-') });
const obs = gate.load;

const PROJECT_ID = 'genkit-idx';
const PROJECT_NUMBER = '123456789012';
const APP_ID = `1:${PROJECT_NUMBER}:web:0a1b2c3d4e5f60718293a4`;
const SECRETS: Secrets = { appId: APP_ID, apiKey: '', projectNumber: PROJECT_NUMBER, values: [] };

type AdminAppCheck = {
  createToken(appId: string, options?: { ttlMillis?: number }): Promise<{ token: string; ttlMillis: number }>;
  verifyToken(token: string, options?: { consume?: boolean }): Promise<{ appId: string; token: Record<string, unknown>; alreadyConsumed?: boolean }>;
};
function appCheck(): AdminAppCheck {
  const app = initializeApp({ sandbox: initializeSandbox(), projectId: PROJECT_ID } as Parameters<typeof initializeApp>[0]);
  return getAppCheck(app) as unknown as AdminAppCheck;
}
async function rejection(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { threw: true, code: e.code ?? null, message: String(e.message) };
  }
  return { threw: false };
}

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

const assertions: Record<string, () => Promise<void>> = {
  'app-check-admin#create-token-shape': async () => {
    const o = obs('app-check-admin-create-token-shape');
    const result = await appCheck().createToken(APP_ID);
    expect(Object.keys(result).sort()).toEqual(o.resultKeySet);
    expect(result.ttlMillis).toBe(o.ttlMillis);
    expect({ ...jwtShape(result.token, SECRETS), length: undefined }).toEqual({ ...o.token, length: undefined });
  },
  'app-check-admin#create-token-ttl': async () => {
    const o = obs('app-check-admin-create-token-custom-ttl');
    const service = appCheck();
    const thirty = await service.createToken(APP_ID, { ttlMillis: 30 * 60 * 1000 });
    expect({ ttlMillis: thirty.ttlMillis, ttlSeconds: jwtShape(thirty.token, SECRETS).ttlSeconds }).toEqual(o.thirtyMinutes);
    expect(await rejection(() => service.createToken(APP_ID, { ttlMillis: 29 * 60 * 1000 }))).toEqual(o.twentyNineMinutes);
    expect(await rejection(() => service.createToken(APP_ID, { ttlMillis: 7 * 24 * 60 * 60 * 1000 + 1000 }))).toEqual(o.sevenDaysPlusOneSecond);
  },
  'app-check-admin#create-token-unknown-app': async () => {
    const o = obs('app-check-admin-create-token-unknown-app');
    // Divergence, by design (row app-check-admin#create-token-unknown-app).
    // Production refuses an app id the project does not own:
    expect(o).toEqual({ threw: true, code: 'app-check/unknown-error', message: 'App not registered: 1:<projectNumber>:web:0000000000000000000000.' });
    // The sandbox has no app registrations, so it mints for any non-empty id,
    // and refuses only an empty one.
    const service = appCheck();
    const unknown = `1:${PROJECT_NUMBER}:web:0000000000000000000000`;
    const minted = await service.createToken(unknown);
    expect(jwtShape(minted.token, { ...SECRETS, appId: unknown }).subEqualsAppId).toBe(true);
    expect(await rejection(() => service.createToken(''))).toEqual({ threw: true, code: 'app-check/invalid-argument', message: '`appId` must be a non-empty string.' });
  },
  'app-check-admin#verify-token': async () => {
    const o = obs('app-check-admin-verify-token');
    const service = appCheck();
    const { token } = await service.createToken(APP_ID);
    const describeResult = (result: Awaited<ReturnType<AdminAppCheck['verifyToken']>>) => ({
      resultKeySet: Object.keys(result).sort(),
      appIdEqualsConfig: result.appId === APP_ID,
      decodedClaimNames: Object.keys(result.token).sort(),
      decodedAppIdEqualsConfig: result.token.app_id === APP_ID,
      alreadyConsumed: result.alreadyConsumed ?? null,
    });
    expect(describeResult(await service.verifyToken(token))).toEqual(o.adminMinted);
    // A web-plane token: pyric/app-check's getToken mints through this same
    // shared function, as production's debug exchange mints tokens Admin verifies.
    const web = await mintAppCheckToken({ appId: APP_ID, projectId: PROJECT_ID }, 3600);
    expect(describeResult(await service.verifyToken(web.token))).toEqual(o.debugExchanged);
  },
  'app-check-admin#verify-token-rejections': async () => {
    const o = obs('app-check-admin-verify-tampered');
    const service = appCheck();
    const { token } = await service.createToken(APP_ID);
    expect(await rejection(() => service.verifyToken(tamperSignature(token)))).toEqual(o.tamperedSignature);
    expect(await rejection(() => service.verifyToken('not-a-jwt'))).toEqual(o.notJwt);
    expect(await rejection(() => service.verifyToken(''))).toEqual(o.emptyString);
  },
  'app-check-admin#verify-token-consume': async () => {
    const o = obs('app-check-admin-verify-consume');
    const service = appCheck();
    const { token } = await service.createToken(APP_ID);
    const describeResult = (r: { alreadyConsumed?: boolean }) => ({ resultKeySet: Object.keys(r).sort(), alreadyConsumed: r.alreadyConsumed ?? null });
    expect(describeResult(await service.verifyToken(token, { consume: true }))).toEqual(o.firstConsume);
    expect(describeResult(await service.verifyToken(token, { consume: true }))).toEqual(o.secondConsume);
    expect(describeResult(await service.verifyToken(token))).toEqual(o.plainVerifyAfterConsume);
  },
};

const isExpectedGreen = (status: string) => status === 'conforms' || status === 'diverged-documented';
const adminRows = appCheckRows.filter((row) => row.surface === 'app-check-admin');

describe('oracle conformance (app-check admin)', () => {
  for (const row of adminRows) {
    const register = isExpectedGreen(row.status) || isClimb ? it : it.skip;
    register(`${row.id} ${row.api}`, async () => {
      const assertion = assertions[row.id];
      if (!assertion) throw new Error(`no assertion set authored for ${row.id}`);
      await assertion();
    });
  }

  it('completeness: one assertion set per app-check-admin row (partition gate)', () => {
    expect(Object.keys(assertions).sort()).toEqual(adminRows.map((row) => row.id).sort());
  });

  (isClimb ? it : it.skip)('completeness: every observations/app-check-admin/ capture is asserted (prefix gate)', () => {
    const report = gate.report();
    expect(report.committed.length).toBe(6);
    expect(report.loadedButUnused).toEqual([]);
    expect(report.uncovered).toEqual([]);
  });
});
