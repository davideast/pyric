import { afterEach, describe, expect, it } from 'bun:test';
import {
  REMOTE_SANDBOX,
  createMemoryBackend,
  initializeSandbox,
  type RemoteSandbox,
} from 'pyric/sandbox';
import {
  consumeAppCheckToken,
  MAX_CONSUMED_TOKEN_ID_LENGTH,
  validatePersistedService,
} from 'pyric/sandbox/internal';
import { ADMIN_APP_TARGET, deleteApp, getApps, initializeApp } from '../../src/app/index.js';
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

  it('rejects unbranded, spoofed, non-sandbox, null, primitive, and deleted apps', async () => {
    expect(() => getAppCheck({} as never)).toThrow(TypeError);
    expect(() => getAppCheck(null as never)).toThrow(TypeError);
    expect(() => getAppCheck('not-an-app' as never)).toThrow(TypeError);
    expect(() => getAppCheck(42 as never)).toThrow(TypeError);
    expect(() => getAppCheck([] as never)).toThrow(TypeError);

    expect(() => getAppCheck({ [ADMIN_APP_TARGET]: 'prod' } as never)).toThrow(TypeError);
    expect(() => getAppCheck({ [ADMIN_APP_TARGET]: 'prod', sandbox: {} } as never)).toThrow(TypeError);
    expect(() => getAppCheck({ [ADMIN_APP_TARGET]: 'sandbox' } as never)).toThrow(TypeError);
    expect(() => getAppCheck({ [ADMIN_APP_TARGET]: 'sandbox', sandbox: {} } as never)).toThrow(TypeError);
    expect(() =>
      getAppCheck({ [ADMIN_APP_TARGET]: 'sandbox', sandbox: {}, options: {}, name: 'x' } as never),
    ).toThrow(TypeError);

    const app = initializeApp({ sandbox: initializeSandbox(), projectId: 'demo-appcheck' }, 'ac-brand');
    await deleteApp(app);
    expect(() => getAppCheck(app)).toThrow(/already been deleted/);
  });

  it('persists consumed token ids in the sandbox across snapshots, persistence backends, resetAll, and sibling apps (#1297)', async () => {
    const memoryBackend = createMemoryBackend();
    const firstSandbox = initializeSandbox();
    await firstSandbox.enablePersistence({ key: 'ac-consume-persist', injectedBackend: memoryBackend });

    const appOne = initializeApp({ sandbox: firstSandbox, projectId: 'demo-appcheck' }, 'ac-p1');
    const appSibling = initializeApp({ sandbox: firstSandbox, projectId: 'demo-appcheck' }, 'ac-p2');
    const serviceOne = getAppCheck(appOne);
    const serviceSibling = getAppCheck(appSibling);

    const { token } = await serviceOne.createToken(APP_ID);
    const firstConsume = await serviceOne.verifyToken(token, { consume: true });
    expect(firstConsume.alreadyConsumed).toBe(false);

    // Sibling admin app on the same sandbox sees it already consumed.
    const siblingConsume = await serviceSibling.verifyToken(token, { consume: true });
    expect(siblingConsume.alreadyConsumed).toBe(true);

    // Plain verify after consume omits alreadyConsumed.
    const plainVerify = await serviceOne.verifyToken(token);
    expect('alreadyConsumed' in plainVerify).toBe(false);

    await firstSandbox.flush();
    const snapshot = firstSandbox.snapshot();

    // Restoring via loadSnapshot into an unrelated sandbox preserves consumption even before first getAppCheck.
    const snapshotRestored = initializeSandbox();
    snapshotRestored.loadSnapshot(snapshot);
    const restoredApp = initializeApp(
      { sandbox: snapshotRestored, projectId: 'demo-appcheck' },
      'ac-snap-restored',
    );
    const afterSnapshotLoad = await getAppCheck(restoredApp).verifyToken(token, { consume: true });
    expect(afterSnapshotLoad.alreadyConsumed).toBe(true);

    // Restoring via enablePersistence on a restarted sandbox preserves consumption.
    const restartedSandbox = initializeSandbox();
    await restartedSandbox.enablePersistence({ key: 'ac-consume-persist', injectedBackend: memoryBackend });
    const restartedApp = initializeApp(
      { sandbox: restartedSandbox, projectId: 'demo-appcheck' },
      'ac-restarted',
    );
    const afterRestart = await getAppCheck(restartedApp).verifyToken(token, { consume: true });
    expect(afterRestart.alreadyConsumed).toBe(true);

    // resetAll clears the sandbox's consumed set.
    const resetReport = await restartedSandbox.resetAll();
    expect(resetReport.errors).toEqual([]);
    const afterResetAll = await getAppCheck(restartedApp).verifyToken(token, { consume: true });
    expect(afterResetAll.alreadyConsumed).toBe(false);

    firstSandbox.dispose();
    snapshotRestored.dispose();
    restartedSandbox.dispose();
  });

  it('dispatches verifyToken(..., { consume: true }) over RemoteSandbox.channel (#1297)', async () => {
    const remoteConsumed = new Set<string>();
    const remoteNowMillis = Date.UTC(2026, 5, 1, 12, 0, 0);
    const dispatchedOps: Array<{ method: string; tokenId?: string }> = [];
    const remoteSandbox = {
      [REMOTE_SANDBOX]: true as const,
      serveUrl: 'http://localhost:5000',
      withAuth: initializeSandbox().withAuth,
      channel: {
        async op(payload: { method: string; tokenId?: string }) {
          dispatchedOps.push(payload);
          if (payload.method === 'sandbox.clock') {
            return { now: remoteNowMillis };
          }
          if (payload.method === 'appCheck.consumeToken' && typeof payload.tokenId === 'string') {
            const alreadyConsumed = remoteConsumed.has(payload.tokenId);
            remoteConsumed.add(payload.tokenId);
            return { alreadyConsumed };
          }
          throw new Error(`unexpected op: ${payload.method}`);
        },
        subscribe() {
          return () => {};
        },
      },
    } as unknown as RemoteSandbox;

    const appA = initializeApp({ sandbox: remoteSandbox, projectId: 'demo-appcheck' }, 'ac-rem-a');
    const appB = initializeApp({ sandbox: remoteSandbox, projectId: 'demo-appcheck' }, 'ac-rem-b');
    const { token } = await getAppCheck(appA).createToken(APP_ID, {
      limitedUse: true,
      jti: 'remote-jti-42',
    });

    const first = await getAppCheck(appA).verifyToken(token, { consume: true });
    const second = await getAppCheck(appB).verifyToken(token, { consume: true });
    const plain = await getAppCheck(appB).verifyToken(token);

    expect(first.alreadyConsumed).toBe(false);
    expect(second.alreadyConsumed).toBe(true);
    expect('alreadyConsumed' in plain).toBe(false);
    expect(dispatchedOps).toEqual([
      { method: 'sandbox.clock' },
      { method: 'sandbox.clock' },
      { method: 'appCheck.consumeToken', tokenId: 'remote-jti-42' },
      { method: 'sandbox.clock' },
      { method: 'appCheck.consumeToken', tokenId: 'remote-jti-42' },
      { method: 'sandbox.clock' },
    ]);
  });

  it('roundtrips a 5000-character tokenId through validatePersistedService and rejects out-of-bounds tokenIds (#1297)', () => {
    const sandbox = initializeSandbox();
    try {
      const longTokenId = 't'.repeat(5000);
      expect(consumeAppCheckToken(sandbox, longTokenId)).toEqual({ alreadyConsumed: false });
      expect(consumeAppCheckToken(sandbox, longTokenId)).toEqual({ alreadyConsumed: true });

      expect(() => consumeAppCheckToken(sandbox, '')).toThrow(RangeError);
      expect(() =>
        consumeAppCheckToken(sandbox, 'x'.repeat(MAX_CONSUMED_TOKEN_ID_LENGTH + 1)),
      ).toThrow(RangeError);

      const snapshot = sandbox.snapshot();
      expect(() =>
        validatePersistedService('app-check', snapshot.services['app-check']),
      ).not.toThrow();

      const restored = initializeSandbox();
      try {
        restored.loadSnapshot(snapshot);
        expect(consumeAppCheckToken(restored, longTokenId)).toEqual({ alreadyConsumed: true });
      } finally {
        restored.dispose();
      }
    } finally {
      sandbox.dispose();
    }
  });
});
