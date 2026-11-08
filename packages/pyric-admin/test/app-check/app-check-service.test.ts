import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getAppCheck } from '../../src/app-check/index.js';

const APP_ID = '1:123456789012:web:0a1b2c3d4e5f60718293a4';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('AppCheck service and createToken / verifyToken options', () => {
  it('validates appId and AppCheckTokenOptions synchronously before minting', () => {
    const app = initializeApp({ sandbox: initializeSandbox(), projectId: 'demo-appcheck' }, 'ac-sync');
    const appCheck = getAppCheck(app);
    expect(() => appCheck.createToken('')).toThrow(/`appId` must be a non-empty string/);
    expect(() => appCheck.createToken(APP_ID, null as never)).toThrow(
      /AppCheckTokenOptions must be a non-null object/,
    );
    expect(() => appCheck.createToken(APP_ID, { ttlMillis: Number.NaN })).toThrow(
      /ttlMillis must be a duration in milliseconds\./,
    );
    expect(() => appCheck.createToken(APP_ID, { ttlMillis: 1000 })).toThrow(
      /between 30 minutes and 7 days/,
    );
  });

  it('validates limitedUse and jti options asynchronously and honors 5-minute default TTL and shared jti consumption', async () => {
    const app = initializeApp({ sandbox: initializeSandbox(), projectId: 'demo-appcheck' }, 'ac-jti');
    const appCheck = getAppCheck(app);

    await expect(appCheck.createToken(APP_ID, { jti: 'token-id-1' })).rejects.toThrow(
      /`jti` cannot be specified without setting `limitedUse` to `true`/,
    );
    await expect(appCheck.createToken(APP_ID, { limitedUse: 'true' as never })).rejects.toThrow(
      /`limitedUse` must be a boolean value/,
    );
    await expect(appCheck.createToken(APP_ID, { limitedUse: true, jti: 42 as never })).rejects.toThrow(
      /`jti` must be a string value/,
    );

    const defaultLimitedUse = await appCheck.createToken(APP_ID, { limitedUse: true });
    expect(defaultLimitedUse.ttlMillis).toBe(300_000);

    const first = await appCheck.createToken(APP_ID, { limitedUse: true, jti: 'shared-jti-1' });
    const second = await appCheck.createToken(APP_ID, { limitedUse: true, jti: 'shared-jti-1' });
    expect(first.token).not.toBe(second.token);

    const v1 = await appCheck.verifyToken(first.token, { consume: true });
    expect(Object.keys(v1)).toEqual(['alreadyConsumed', 'appId', 'token']);
    expect(v1.alreadyConsumed).toBe(false);

    const v2 = await appCheck.verifyToken(second.token, { consume: true });
    expect(v2.alreadyConsumed).toBe(true);
  });

  it('rounds JWT lifetime in seconds and floors returned fractional ttlMillis', async () => {
    const app = initializeApp({ sandbox: initializeSandbox(), projectId: 'demo-appcheck' }, 'ac-frac');
    const appCheck = getAppCheck(app);
    const minted = await appCheck.createToken(APP_ID, { ttlMillis: 1_800_999.7 });
    expect(minted.ttlMillis).toBe(1_800_999);
    const [, payload] = minted.token.split('.');
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as {
      iat: number;
      exp: number;
    };
    expect(claims.exp - claims.iat).toBe(1801);
  });
});
