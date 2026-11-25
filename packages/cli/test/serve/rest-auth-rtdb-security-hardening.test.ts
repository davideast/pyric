import { afterEach, describe, expect, it } from 'bun:test';
import { sandbox as authSandbox } from 'pyric/auth';
import { getFirestore } from 'pyric/firestore';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { authAccountsFor, encodeJson, getClock, signIdToken } from 'pyric/sandbox/internal';
import {
  createRestAuthRtdbHandler,
  MAX_REFRESH_SESSIONS_PER_HOST,
} from '../../src/serve/rest-auth-rtdb.js';
import { silentServeLogger, startStaticServer, type ServeHandle } from '../../src/serve/server.js';
import { setDatabaseRules } from '../../src/serve/worker/host/rules.js';
import { ensureAuth, type HostCtx } from '../../src/serve/worker/host.js';

const PROJECT_ID = 'demo-project';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const next = cleanups.pop();
    if (next !== undefined) await next();
  }
});

function makeUnsignedOidcJwt(claims: Record<string, unknown>): string {
  return `${encodeJson({ alg: 'none', typ: 'JWT' })}.${encodeJson(claims)}.`;
}

async function startDirectRestServer(options?: {
  maxRefreshSessions?: number;
}): Promise<{ server: ServeHandle; ctx: HostCtx; sandbox: LocalSandbox }> {
  const sandbox = initializeSandbox();
  const ctx: HostCtx = {
    sandbox,
    flushPersistence: async () => {},
    db: getFirestore(sandbox),
    instanceId: 'rest-security-hardening-ctx',
    rtdbProjectId: PROJECT_ID,
    defaultRtdbInstance: `${PROJECT_ID}-default-rtdb`,
    subs: new Map(),
  };
  ensureAuth(ctx);
  setDatabaseRules(
    ctx,
    undefined,
    JSON.stringify({ rules: { '.read': 'auth != null', '.write': 'auth != null' } }),
  );
  const restHandler = createRestAuthRtdbHandler({
    ctx,
    maxRefreshSessions: options?.maxRefreshSessions,
  });
  const server = await startStaticServer({
    publicDir: null,
    port: 0,
    host: '127.0.0.1',
    logger: silentServeLogger(),
    restHandler,
  });
  cleanups.push(async () => {
    await server.stop();
    sandbox.dispose();
  });
  return { server, ctx, sandbox };
}

async function signInViaIdp(
  baseUrl: string,
  uid: string,
  email: string,
): Promise<{ idToken: string; refreshToken: string }> {
  const res = await fetch(`${baseUrl}/v1/accounts:signInWithIdp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      postBody: `id_token=${encodeURIComponent(makeUnsignedOidcJwt({ sub: uid, email }))}&providerId=google.com`,
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { idToken: string; refreshToken: string };
}

async function exchangeRefreshToken(baseUrl: string, refreshToken: string): Promise<Response> {
  return fetch(`${baseUrl}/v1/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
}

describe('rest-auth-rtdb account standing and revocation enforcement', () => {
  it('rejects unexpired ID tokens and refresh tokens after account deletion, including after uid recreation', async () => {
    const direct = await startDirectRestServer();
    const auth = ensureAuth(direct.ctx);
    const login = await signInViaIdp(direct.server.url, 'uid-deleted', 'deleted@example.com');

    const beforePut = await fetch(`${direct.server.url}/items/a.json`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${login.idToken}`,
      },
      body: JSON.stringify({ ok: true }),
    });
    expect(beforePut.status).toBe(200);

    getClock(direct.sandbox).advance(2000);
    authSandbox.deleteUser(auth, 'uid-deleted');

    // Unexpired ID token fails closed on both query ?auth= and Authorization: Bearer.
    const queryAfterDelete = await fetch(
      `${direct.server.url}/items/a.json?auth=${encodeURIComponent(login.idToken)}`,
    );
    expect(queryAfterDelete.status).toBe(401);
    expect(await queryAfterDelete.json()).toEqual({ error: 'Could not parse auth token.' });

    const bearerAfterDelete = await fetch(`${direct.server.url}/items/a.json`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${login.idToken}`,
      },
      body: JSON.stringify({ ok: false }),
    });
    expect(bearerAfterDelete.status).toBe(401);

    // Refresh token also fails closed after account deletion.
    const refreshAfterDelete = await exchangeRefreshToken(direct.server.url, login.refreshToken);
    expect(refreshAfterDelete.status).toBe(400);
    expect(await refreshAfterDelete.json()).toEqual({
      error: { code: 400, message: 'INVALID_REFRESH_TOKEN', status: 'INVALID_ARGUMENT' },
    });

    // Re-creating the same uid keeps old pre-deletion ID tokens rejected while allowing new sign-ins.
    getClock(direct.sandbox).advance(2000);
    const recreatedLogin = await signInViaIdp(direct.server.url, 'uid-deleted', 'deleted@example.com');
    const oldTokenAfterRecreate = await fetch(
      `${direct.server.url}/items/a.json?auth=${encodeURIComponent(login.idToken)}`,
    );
    expect(oldTokenAfterRecreate.status).toBe(401);

    const newTokenAfterRecreate = await fetch(
      `${direct.server.url}/items/a.json?auth=${encodeURIComponent(recreatedLogin.idToken)}`,
    );
    expect(newTokenAfterRecreate.status).toBe(200);
    expect(await newTokenAfterRecreate.json()).toEqual({ ok: true });
  });

  it('rejects revoked ID tokens via tokensValidAfterMs while honoring whole-second boundaries and fresh sign-ins', async () => {
    const direct = await startDirectRestServer();
    const accounts = authAccountsFor(direct.sandbox);
    expect(accounts).toBeDefined();
    if (accounts === undefined) return;

    const initialLogin = await signInViaIdp(direct.server.url, 'uid-revoked', 'revoked@example.com');
    expect(
      (await fetch(`${direct.server.url}/probe.json?auth=${encodeURIComponent(initialLogin.idToken)}`))
        .status,
    ).toBe(200);

    // Revoke 2 seconds after initial sign-in.
    getClock(direct.sandbox).advance(2000);
    accounts.revokeRefreshTokens('uid-revoked');

    const revokedQuery = await fetch(
      `${direct.server.url}/probe.json?auth=${encodeURIComponent(initialLogin.idToken)}`,
    );
    expect(revokedQuery.status).toBe(401);
    expect(await revokedQuery.json()).toEqual({ error: 'Could not parse auth token.' });

    const revokedBearer = await fetch(`${direct.server.url}/probe.json`, {
      headers: { authorization: `Bearer ${initialLogin.idToken}` },
    });
    expect(revokedBearer.status).toBe(401);

    const revokedRefresh = await exchangeRefreshToken(direct.server.url, initialLogin.refreshToken);
    expect(revokedRefresh.status).toBe(400);

    // A token issued in the exact same whole second as revocation stays valid, matching production.
    const nowSec = Math.floor(getClock(direct.sandbox).now() / 1000);
    const sameSecondToken = await signIdToken({
      sub: 'uid-revoked',
      user_id: 'uid-revoked',
      aud: PROJECT_ID,
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      auth_time: nowSec,
      iat: nowSec,
      exp: nowSec + 3600,
    });
    expect(
      (await fetch(`${direct.server.url}/probe.json?auth=${encodeURIComponent(sameSecondToken)}`)).status,
    ).toBe(200);

    // A token with auth_time before tokensValidAfterMs fails closed even if iat is newer.
    const staleAuthTimeToken = await signIdToken({
      sub: 'uid-revoked',
      user_id: 'uid-revoked',
      aud: PROJECT_ID,
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      auth_time: nowSec - 1,
      iat: nowSec + 5,
      exp: nowSec + 3600,
    });
    expect(
      (await fetch(`${direct.server.url}/probe.json?auth=${encodeURIComponent(staleAuthTimeToken)}`))
        .status,
    ).toBe(401);

    // Tokens missing auth_time/iat or carrying non-numeric timestamps fail closed when revoked.
    const missingTimestampsToken = await signIdToken({
      sub: 'uid-revoked',
      user_id: 'uid-revoked',
      aud: PROJECT_ID,
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      exp: nowSec + 3600,
    });
    expect(
      (await fetch(`${direct.server.url}/probe.json?auth=${encodeURIComponent(missingTimestampsToken)}`))
        .status,
    ).toBe(401);

    const badAuthTimeToken = await signIdToken({
      sub: 'uid-revoked',
      user_id: 'uid-revoked',
      aud: PROJECT_ID,
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      auth_time: 'not-a-number',
      iat: nowSec + 10,
      exp: nowSec + 3600,
    });
    expect(
      (await fetch(`${direct.server.url}/probe.json?auth=${encodeURIComponent(badAuthTimeToken)}`)).status,
    ).toBe(401);

    // Re-signing in after revocation issues a fresh accepted ID token.
    getClock(direct.sandbox).advance(1000);
    const freshLogin = await signInViaIdp(direct.server.url, 'uid-revoked', 'revoked@example.com');
    expect(
      (await fetch(`${direct.server.url}/probe.json?auth=${encodeURIComponent(freshLogin.idToken)}`))
        .status,
    ).toBe(200);

    // Restored unrecorded sessions without a stored user record remain accepted (#1515).
    const unrecordedSec = Math.floor(getClock(direct.sandbox).now() / 1000);
    const unrecordedToken = await signIdToken({
      sub: 'uid-unrecorded-restored',
      user_id: 'uid-unrecorded-restored',
      aud: PROJECT_ID,
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      auth_time: unrecordedSec,
      iat: unrecordedSec,
      exp: unrecordedSec + 3600,
    });
    expect(
      (await fetch(`${direct.server.url}/probe.json?auth=${encodeURIComponent(unrecordedToken)}`)).status,
    ).toBe(200);
  });

  it('rejects both RTDB REST and refresh exchanges for disabled accounts', async () => {
    const direct = await startDirectRestServer();
    const auth = ensureAuth(direct.ctx);
    const login = await signInViaIdp(direct.server.url, 'uid-disabled', 'disabled@example.com');

    authSandbox.updateUser(auth, 'uid-disabled', { disabled: true });

    expect(
      (await fetch(`${direct.server.url}/probe.json?auth=${encodeURIComponent(login.idToken)}`)).status,
    ).toBe(401);
    expect((await exchangeRefreshToken(direct.server.url, login.refreshToken)).status).toBe(400);
  });
});

describe('rest-auth-rtdb bounded refreshSessionsByCtx eviction', () => {
  it('evicts oldest refresh tokens deterministically when maxRefreshSessions is exceeded without dropping active rotations', async () => {
    const direct = await startDirectRestServer({ maxRefreshSessions: 4 });
    const issued: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const login = await signInViaIdp(
        direct.server.url,
        `uid-cap-${index}`,
        `cap-${index}@example.com`,
      );
      issued.push(login.refreshToken);
    }

    // Oldest 2 tokens were evicted FIFO.
    expect((await exchangeRefreshToken(direct.server.url, issued[0] ?? '')).status).toBe(400);
    expect((await exchangeRefreshToken(direct.server.url, issued[1] ?? '')).status).toBe(400);

    // Rotating token 2 frees its slot first so tokens 3, 4, and 5 stay valid.
    const rotated2 = await exchangeRefreshToken(direct.server.url, issued[2] ?? '');
    expect(rotated2.status).toBe(200);
    const rotated2Body = (await rotated2.json()) as { refresh_token: string };
    expect(rotated2Body.refresh_token.length).toBeGreaterThan(0);

    expect((await exchangeRefreshToken(direct.server.url, issued[3] ?? '')).status).toBe(200);
    expect((await exchangeRefreshToken(direct.server.url, issued[4] ?? '')).status).toBe(200);
    expect((await exchangeRefreshToken(direct.server.url, issued[5] ?? '')).status).toBe(200);
    expect((await exchangeRefreshToken(direct.server.url, rotated2Body.refresh_token)).status).toBe(200);
  });

  it('enforces MAX_REFRESH_SESSIONS_PER_HOST by default and clamps invalid maxRefreshSessions values safely', async () => {
    // Low/non-positive values clamp to 1 (never disabling storage or crashing).
    const clampedLow = await startDirectRestServer({ maxRefreshSessions: 0 });
    const first = await signInViaIdp(clampedLow.server.url, 'uid-low-1', 'low1@example.com');
    const second = await signInViaIdp(clampedLow.server.url, 'uid-low-2', 'low2@example.com');
    expect((await exchangeRefreshToken(clampedLow.server.url, first.refreshToken)).status).toBe(400);
    expect((await exchangeRefreshToken(clampedLow.server.url, second.refreshToken)).status).toBe(200);

    // Default cap bounds growth even under sustained sign-in floods (> MAX_REFRESH_SESSIONS_PER_HOST).
    const unboundedAttempt = await startDirectRestServer({
      maxRefreshSessions: Number.POSITIVE_INFINITY,
    });
    const tokens: string[] = [];
    const overflowCount = 6;
    for (let index = 0; index < MAX_REFRESH_SESSIONS_PER_HOST + overflowCount; index += 1) {
      const login = await signInViaIdp(
        unboundedAttempt.server.url,
        'uid-flood',
        'flood@example.com',
      );
      tokens.push(login.refreshToken);
    }

    for (let index = 0; index < overflowCount; index += 1) {
      const evictedRes = await exchangeRefreshToken(unboundedAttempt.server.url, tokens[index] ?? '');
      expect(evictedRes.status).toBe(400);
    }
    const oldestRetained = await exchangeRefreshToken(
      unboundedAttempt.server.url,
      tokens[overflowCount] ?? '',
    );
    expect(oldestRetained.status).toBe(200);
    const newestRetained = await exchangeRefreshToken(
      unboundedAttempt.server.url,
      tokens[tokens.length - 1] ?? '',
    );
    expect(newestRetained.status).toBe(200);
  });
});
