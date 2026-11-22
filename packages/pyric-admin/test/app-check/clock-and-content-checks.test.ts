import { afterEach, describe, expect, it } from 'bun:test';
import { REMOTE_SANDBOX, getClock, initializeSandbox, type RemoteSandbox } from 'pyric/sandbox';
import { signAppCheckToken } from 'pyric/sandbox/internal';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getAppCheck } from '../../src/app-check/index.js';

const PROJECT_ID = 'demo-appcheck-clock';
const PROJECT_NUMBER = '123456789012';
const APP_ID = `1:${PROJECT_NUMBER}:web:0a1b2c3d4e5f60718293a4`;
const SANDBOX_HEADER = { alg: 'RS256', kid: 'pyric-sandbox', typ: 'JWT' };

const sandboxes: Array<ReturnType<typeof initializeSandbox>> = [];

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
  while (sandboxes.length > 0) {
    const sb = sandboxes.pop();
    if (sb !== undefined) sb.dispose();
  }
});

async function rejection(operation: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await operation();
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { code: String(e.code), message: String(e.message) };
  }
  throw new Error('expected promise to reject');
}

describe('#1851: pyric-admin verifyToken and createToken follow the sandbox clock', () => {
  it('local arm: checks nbf and exp against getClock(sandbox) instead of wall clock', async () => {
    const sandbox = initializeSandbox();
    sandboxes.push(sandbox);
    const clock = getClock(sandbox);
    const startMillis = Date.UTC(2026, 0, 1, 0, 0, 0);
    clock.set(startMillis);

    const app = initializeApp({ sandbox, projectId: PROJECT_ID }, 'ac-clock-local');
    const appCheck = getAppCheck(app);

    // Token minted at fixed sandbox instant (far from wall clock) expires relative to clock.now().
    const { token } = await appCheck.createToken(APP_ID);
    const verified = await appCheck.verifyToken(token);
    expect(verified.appId).toBe(APP_ID);
    const expectedIat = Math.floor(startMillis / 1000);
    expect(verified.token.iat).toBe(expectedIat);
    expect(verified.token.exp).toBe(expectedIat + 3600);

    // One second before expiry is still valid.
    clock.set((expectedIat + 3599) * 1000);
    expect((await appCheck.verifyToken(token)).appId).toBe(APP_ID);

    // At exact expiry (nowSeconds === exp), verifyToken rejects as expired.
    clock.advance(1000);
    expect(await rejection(() => appCheck.verifyToken(token))).toEqual({
      code: 'app-check/app-check-token-expired',
      message:
        'The provided App Check token has expired. Get a fresh App Check token from your client app and try again.',
    });

    // Future nbf relative to sandbox clock fails with invalid signature until clock reaches nbf.
    const nbfToken = await signAppCheckToken(SANDBOX_HEADER, {
      sub: APP_ID,
      aud: [`projects/${PROJECT_NUMBER}`, `projects/${PROJECT_ID}`],
      provider: 'pyric-sandbox',
      iss: `https://firebaseappcheck.googleapis.com/${PROJECT_NUMBER}`,
      iat: expectedIat,
      nbf: expectedIat + 7200,
      exp: expectedIat + 10_800,
      jti: 'nbf-local-1',
    });
    expect(await rejection(() => appCheck.verifyToken(nbfToken))).toEqual({
      code: 'app-check/invalid-argument',
      message: 'The provided App Check token has invalid signature.',
    });

    clock.set((expectedIat + 7200) * 1000);
    expect((await appCheck.verifyToken(nbfToken)).appId).toBe(APP_ID);
  });

  it('remote arm: reads sandbox.clock op for createToken, verifyNotBefore, and verifyExpiry', async () => {
    let remoteClockMillis = Date.UTC(2026, 2, 15, 8, 0, 0);
    const ops: string[] = [];
    const baseSandbox = initializeSandbox();
    sandboxes.push(baseSandbox);

    const remoteSandbox = {
      [REMOTE_SANDBOX]: true as const,
      serveUrl: 'http://localhost:5000',
      withAuth: baseSandbox.withAuth,
      channel: {
        async op(payload: { method: string }) {
          ops.push(payload.method);
          if (payload.method === 'sandbox.clock') {
            return { now: remoteClockMillis };
          }
          throw new Error(`unexpected op: ${payload.method}`);
        },
        subscribe() {
          return () => {};
        },
      },
    } as unknown as RemoteSandbox;

    const app = initializeApp({ sandbox: remoteSandbox, projectId: PROJECT_ID }, 'ac-clock-remote');
    const appCheck = getAppCheck(app);

    const { token } = await appCheck.createToken(APP_ID);
    const verified = await appCheck.verifyToken(token);
    const expectedIat = Math.floor(remoteClockMillis / 1000);
    expect(verified.token.iat).toBe(expectedIat);
    expect(verified.token.exp).toBe(expectedIat + 3600);

    // Advance remote clock past expiry (even if wall clock is in a different year/hour).
    remoteClockMillis += 3600 * 1000;
    expect(await rejection(() => appCheck.verifyToken(token))).toEqual({
      code: 'app-check/app-check-token-expired',
      message:
        'The provided App Check token has expired. Get a fresh App Check token from your client app and try again.',
    });

    // Future nbf checked against remote sandbox.clock op.
    const nbfSeconds = Math.floor(remoteClockMillis / 1000) + 600;
    const nbfToken = await signAppCheckToken(SANDBOX_HEADER, {
      sub: APP_ID,
      aud: [`projects/${PROJECT_NUMBER}`, `projects/${PROJECT_ID}`],
      provider: 'pyric-sandbox',
      iss: `https://firebaseappcheck.googleapis.com/${PROJECT_NUMBER}`,
      iat: expectedIat,
      nbf: nbfSeconds,
      exp: nbfSeconds + 3600,
      jti: 'nbf-remote-1',
    });
    expect(await rejection(() => appCheck.verifyToken(nbfToken))).toEqual({
      code: 'app-check/invalid-argument',
      message: 'The provided App Check token has invalid signature.',
    });

    remoteClockMillis = nbfSeconds * 1000;
    expect((await appCheck.verifyToken(nbfToken)).appId).toBe(APP_ID);
    expect(ops).toEqual([
      'sandbox.clock',
      'sandbox.clock',
      'sandbox.clock',
      'sandbox.clock',
      'sandbox.clock',
    ]);
  });

  it('remote arm: fails closed with app-check/unknown-error if sandbox.clock returns a non-numeric reply', async () => {
    const baseSandbox = initializeSandbox();
    sandboxes.push(baseSandbox);
    const badRemote = {
      [REMOTE_SANDBOX]: true as const,
      serveUrl: 'http://localhost:5000',
      withAuth: baseSandbox.withAuth,
      channel: {
        async op() {
          return { now: 'not-a-number' };
        },
        subscribe() {
          return () => {};
        },
      },
    } as unknown as RemoteSandbox;

    const app = initializeApp({ sandbox: badRemote, projectId: PROJECT_ID }, 'ac-clock-bad-remote');
    const badResult = await rejection(() => getAppCheck(app).createToken(APP_ID));
    expect(badResult.code).toBe('app-check/unknown-error');
  });
});

describe('#1563 item 2: content checks run before the foreign kid branch', () => {
  it('rejects alg: none with foreign kid using the algorithm error, not the foreign-kid message', async () => {
    const sandbox = initializeSandbox();
    sandboxes.push(sandbox);
    const app = initializeApp({ sandbox, projectId: PROJECT_ID }, 'ac-kid-order');
    const appCheck = getAppCheck(app);
    const nowSec = Math.floor(Date.now() / 1000);
    const baseClaims = {
      sub: APP_ID,
      aud: [`projects/${PROJECT_NUMBER}`, `projects/${PROJECT_ID}`],
      provider: 'debug',
      iss: `https://firebaseappcheck.googleapis.com/${PROJECT_NUMBER}`,
      iat: nowSec,
      exp: nowSec + 3600,
      jti: 'foreign-kid-check',
    };

    const algNoneToken = await signAppCheckToken(
      { alg: 'none', kid: 'x', typ: 'JWT' },
      baseClaims,
    );
    expect(await rejection(() => appCheck.verifyToken(algNoneToken))).toEqual({
      code: 'app-check/invalid-argument',
      message: 'The provided App Check token has incorrect algorithm. Expected "RS256" but got "none".',
    });

    const badAudToken = await signAppCheckToken(
      { alg: 'RS256', kid: 'x', typ: 'JWT' },
      { ...baseClaims, aud: ['projects/other-project'] },
    );
    expect(await rejection(() => appCheck.verifyToken(badAudToken))).toEqual({
      code: 'app-check/invalid-argument',
      message: `The provided App Check token has incorrect "aud" (audience) claim. Expected "projects/${PROJECT_ID}" but got "projects/other-project". Make sure the App Check token comes from the same Firebase project as the service account used to authenticate this SDK.`,
    });

    const badIssToken = await signAppCheckToken(
      { alg: 'RS256', kid: 'x', typ: 'JWT' },
      { ...baseClaims, iss: 'https://example.com/123' },
    );
    expect(await rejection(() => appCheck.verifyToken(badIssToken))).toEqual({
      code: 'app-check/invalid-argument',
      message: 'The provided App Check token has incorrect "iss" (issuer) claim.',
    });

    const emptySubToken = await signAppCheckToken(
      { alg: 'RS256', kid: 'x', typ: 'JWT' },
      { ...baseClaims, sub: '' },
    );
    expect(await rejection(() => appCheck.verifyToken(emptySubToken))).toEqual({
      code: 'app-check/invalid-argument',
      message: 'The provided App Check token has an empty string "sub" (subject) claim.',
    });
  });
});
