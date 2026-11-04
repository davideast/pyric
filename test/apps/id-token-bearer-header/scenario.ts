// An app's server reads the ID token from `Authorization: Bearer <token>`,
// splits the header on the space, and verifies the token with firebase-admin
// (#1836). Production's ID token is a JWT, three base64url segments with no
// whitespace whatever the claims hold. Pyric's used to carry the claims as
// JSON, so a display name with a space, such as `Builder One`, cut the token
// at the space and verifyIdToken failed to parse it, and a name outside
// Latin-1, such as `李`, made the browser refuse the header before the request
// left the page.
//
// The token's `iss` and `aud` name the app's project, as production's do
// (#1503): `https://securetoken.google.com/<projectId>` and the project id.
//
// An ID token lasts one hour, as production's does. After `pyric sandbox
// advanceClock` moves the sandbox clock 61 minutes, the page's next
// getIdToken() returns a new token, and the API verifies it.
//
// The page runs on the hosted dev server. The API is a
// `node --import @pyric/cli/register` process, which also signs in through
// firebase/auth itself and sends its own token.
//
// When an administrator disables or deletes an account, or changes its
// password, production refuses the held session's next token refresh and the
// client SDK signs the user out (#1950). The page holds a session, `pyric auth`
// changes the account the way an administrator would, and the page's forced
// refresh fails with production's code and its auth listener sees null. A
// page that changes its own password keeps its session, across a reload too,
// while the account's session in another browser is refused.
//
// The API refuses what production refuses (#1949): a token whose claims were
// edited after signing, an expired token, a token for another project, a
// custom token, and a plain string each get 401, with firebase-admin's reason.
//
// A custom token the API mints with createCustomToken is exchanged with
// signInWithCustomToken, from the page and from the API's own process, and
// the API verifies the ID token that comes back, with the uid and the
// developer claim (#1952). A custom token minted for another project fails
// with auth/custom-token-mismatch, and an edited, malformed or expired one
// with auth/invalid-custom-token, as production answers.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { scenario } from '../driver.ts';

interface Answer { status?: number; body?: Record<string, unknown>; threw?: string }
declare function runBearer(apiUrl: string, displayName: string, email: string): Promise<{ uid: string; answer: Answer }>;
declare function signInHeld(displayName: string, email: string): Promise<{ uid: string; idToken: string }>;
declare function callApiAsCurrentUser(apiUrl: string): Promise<{ idToken: string; answer: Answer }>;
declare function forceRefresh(): Promise<{ code: string | null; currentUid: string | null; lastAuthState: string | null }>;
declare function restoredUid(): Promise<string | null>;
declare function signInExisting(email: string, password: string): Promise<string>;
declare function changeOwnPassword(newPassword: string): Promise<void>;
declare function exchangeCustomToken(apiUrl: string, uid: string, project?: string): Promise<{ token: string; uid?: string; answer?: Answer; code?: string }>;
declare function exchangeGivenToken(token: string): Promise<{ code: string | null }>;

const PROJECT = 'demo-bearer';

function verified(uid: string, name: string): Answer {
  return { status: 200, body: { uid, name, aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}` } };
}

const SIXTY_ONE_MINUTES_MS = 61 * 60 * 1000;

/** The `iat` and `exp` a token's payload segment carries. */
function tokenTimes(token: string): { iat: number; exp: number } {
  const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { iat: number; exp: number };
  return { iat: payload.iat, exp: payload.exp };
}

function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * An ID token signed as pyric's Auth signs one (packages/pyric/src/sandbox/
 * internal/sandbox-jwt.ts and id-token.ts): eight SHA-256 blocks over the
 * signing input and the ID token key. The sandbox signer is not a security
 * boundary, so a test can sign the expired and wrong-project tokens a real
 * client never would, and only the claim under test is wrong.
 */
function signedIdToken(claims: Record<string, unknown>): string {
  const input = `${segment({ alg: 'RS256', kid: 'pyric-sandbox', typ: 'JWT' })}.${segment(claims)}`;
  const blocks = Array.from({ length: 8 }, (_, block) =>
    createHash('sha256').update(`${block}.pyric-sandbox-id-token-signing-key.${input}`, 'utf8').digest());
  return `${input}.${Buffer.concat(blocks).toString('base64url')}`;
}

function idTokenClaims(uid: string, projectId: string, issuedAtSec: number): Record<string, unknown> {
  return {
    iss: `https://securetoken.google.com/${projectId}`,
    aud: projectId,
    sub: uid,
    user_id: uid,
    auth_time: issuedAtSec,
    iat: issuedAtSec,
    exp: issuedAtSec + 3600,
    firebase: { identities: {}, sign_in_provider: 'custom' },
  };
}

/** The API's answer to `token` in an `Authorization: Bearer` header. */
async function whoami(apiUrl: string, token: string): Promise<{ status: number; body: { error?: string } }> {
  const response = await fetch(`${apiUrl}/whoami`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json() as { error?: string } };
}

function assertRefused(answer: { status: number; body: { error?: string } }, reason: RegExp): void {
  assert.equal(answer.status, 401, JSON.stringify(answer));
  assert.match(answer.body.error ?? '', reason, JSON.stringify(answer));
}

const USERS = [
  { displayName: 'Builder One', email: 'builder@example.com' },
  { displayName: '李', email: 'li@example.com' },
];

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());

  const apiUrl = await app.step('start the API under register', async () => {
    const port = await app.freePort();
    const server = app.serverProcess('api-server.mjs', [], { env: { PYRIC_SANDBOX: `remote:${host.url}`, API_PORT: String(port) } });
    await server.waitForLog(/api-server listening/);
    return `http://127.0.0.1:${port}`;
  });

  const page = await app.step('open the page', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'runBearer' in window);
    return page;
  });

  for (const { displayName, email } of USERS) {
    await app.step(`the API verifies the Bearer token of a user named ${displayName}`, async () => {
      const { uid, answer } = await page.evaluate(
        ([url, name, address]) => runBearer(url, name, address),
        [apiUrl, displayName, email] as const,
      );
      assert.deepEqual(answer, verified(uid, displayName), JSON.stringify(answer));
    });
  }

  await app.step('the API verifies the Bearer token its own process signs in for', async () => {
    const response = await fetch(`${apiUrl}/self`);
    const result = await response.json() as { uid?: string; answer?: Answer; threw?: string };
    assert.equal(result.threw, undefined, JSON.stringify(result));
    assert.deepEqual(result.answer, verified(result.uid ?? '', 'Builder One'), JSON.stringify(result));
  });

  const minted = await app.step('the page exchanges a custom token the API mints, and the API verifies the ID token it gets back', async () => {
    const result = await page.evaluate(([url]) => exchangeCustomToken(url, 'custom-uid'), [apiUrl] as const);
    assert.equal(result.code, undefined, JSON.stringify(result));
    assert.equal(result.uid, 'custom-uid', JSON.stringify(result));
    assert.deepEqual(result.answer, { status: 200, body: { uid: 'custom-uid', role: 'editor', provider: 'custom' } }, JSON.stringify(result));
    return result.token;
  });

  await app.step('the API exchanges a custom token from its own process, and verifies the ID token it gets back', async () => {
    const result = await (await fetch(`${apiUrl}/self-custom`)).json() as { uid?: string; answer?: Answer; threw?: string };
    assert.equal(result.threw, undefined, JSON.stringify(result));
    assert.deepEqual(result.answer, { status: 200, body: { uid: 'server-custom-uid', role: 'editor', provider: 'custom' } }, JSON.stringify(result));
  });

  await app.step('the API refuses the custom token itself as an ID token', async () => {
    assertRefused(await whoami(apiUrl, minted), /was given a custom token/);
  });

  await app.step('the page cannot exchange a custom token minted for another project', async () => {
    const result = await page.evaluate(([url]) => exchangeCustomToken(url, 'custom-uid', 'other'), [apiUrl] as const);
    assert.equal(result.code, 'auth/custom-token-mismatch', JSON.stringify(result));
  });

  await app.step('the page cannot exchange a custom token whose claims were edited after signing', async () => {
    const [header, payload, signature] = minted.split('.');
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    const forged = `${header}.${segment({ ...claims, uid: 'victim-uid', claims: { admin: true } })}.${signature}`;
    for (const token of [forged, 'not-a-token']) {
      const result = await page.evaluate((given) => exchangeGivenToken(given), token);
      assert.equal(result.code, 'auth/invalid-custom-token', JSON.stringify({ token, result }));
    }
  });

  const held = await app.step('a signed-in page holds a token that lasts one hour', async () => {
    const signedIn = await page.evaluate(([name, address]) => signInHeld(name, address), ['Builder One', 'held@example.com'] as const);
    const times = tokenTimes(signedIn.idToken);
    assert.equal(times.exp - times.iat, 3600, JSON.stringify(times));
    return signedIn;
  });

  await app.step('the API refuses a forged token, whose claims were edited after signing', async () => {
    const [header, , signature] = held.idToken.split('.');
    const nowSec = Math.floor(Date.now() / 1000);
    const forgedClaims = { ...idTokenClaims('victim-uid', PROJECT, nowSec), admin: true };
    assertRefused(await whoami(apiUrl, `${header}.${segment(forgedClaims)}.${signature}`), /has invalid signature/);
  });

  await app.step('the API verifies a token signed for its project, so the refusals below are for the claim under test', async () => {
    const answer = await whoami(apiUrl, signedIdToken(idTokenClaims('signed-uid', PROJECT, Math.floor(Date.now() / 1000))));
    assert.equal(answer.status, 200, JSON.stringify(answer));
  });

  await app.step('the API refuses an expired token', async () => {
    const twoHoursAgoSec = Math.floor(Date.now() / 1000) - 2 * 60 * 60;
    assertRefused(await whoami(apiUrl, signedIdToken(idTokenClaims('signed-uid', PROJECT, twoHoursAgoSec))), /has expired/);
  });

  await app.step('the API refuses a token for another project', async () => {
    const other = signedIdToken(idTokenClaims('signed-uid', 'demo-other-project', Math.floor(Date.now() / 1000)));
    assertRefused(await whoami(apiUrl, other), /incorrect "aud" \(audience\) claim/);
  });

  await app.step('the API refuses a plain string', async () => {
    for (const token of ['pyric-sandbox-custom:victim-uid:{"admin":true}', 'not-a-token']) {
      assertRefused(await whoami(apiUrl, token), /Decoding Firebase ID token failed/);
    }
  });

  await app.step('pyric sandbox advanceClock moves the clock 61 minutes', async () => {
    const result = await app.pyric(['sandbox', 'advanceClock', '--ms', String(SIXTY_ONE_MINUTES_MS)]);
    assert.equal(result.code, 0, result.output);
  });

  await app.step('the page cannot exchange the custom token minted over an hour ago on the sandbox clock', async () => {
    const result = await page.evaluate((given) => exchangeGivenToken(given), minted);
    assert.equal(result.code, 'auth/invalid-custom-token', JSON.stringify(result));
  });

  await app.step("the page's next getIdToken() returns a new token, and the API verifies it", async () => {
    const { idToken, answer } = await page.evaluate((url) => callApiAsCurrentUser(url), apiUrl);
    assert.notEqual(idToken, held.idToken);
    const before = tokenTimes(held.idToken);
    const after = tokenTimes(idToken);
    assert.ok(after.iat - before.iat >= SIXTY_ONE_MINUTES_MS / 1000, JSON.stringify({ before, after }));
    assert.equal(after.exp - after.iat, 3600, JSON.stringify(after));
    assert.deepEqual(answer, verified(held.uid, 'Builder One'), JSON.stringify(answer));
  });

  const ACCOUNT_CHANGES = [
    { change: 'disables', email: 'disabled@example.com', args: (uid: string) => ['auth', 'updateUser', '--uid', uid, '--disabled'], code: 'auth/user-disabled' },
    { change: 'deletes', email: 'deleted@example.com', args: (uid: string) => ['auth', 'deleteUser', '--uid', uid], code: 'auth/user-token-expired' },
    { change: 'changes the password of', email: 'password@example.com', args: (uid: string) => ['auth', 'updateUser', '--uid', uid, '--password', 'changed-secret-pw'], code: 'auth/user-token-expired' },
  ];
  for (const { change, email, args, code } of ACCOUNT_CHANGES) {
    await app.step(`pyric auth ${change} a signed-in account, and the page's next refresh fails with ${code} and signs out`, async () => {
      const { uid } = await page.evaluate(([name, address]) => signInHeld(name, address), ['Builder One', email] as const);
      // Production revokes on a whole second, so a session authenticated in
      // the second of the change keeps refreshing; move past it.
      const tick = await app.pyric(['sandbox', 'advanceClock', '--ms', '2000']);
      assert.equal(tick.code, 0, tick.output);
      const result = await app.pyric(args(uid));
      assert.equal(result.code, 0, result.output);
      const refreshed = await page.evaluate(() => forceRefresh());
      assert.deepEqual(refreshed, { code, currentUid: null, lastAuthState: null });
    });
  }

  await app.step('a page that changes its own password and reloads keeps refreshing, while another browser signed in to the account is refused', async () => {
    const email = 'own-password@example.com';
    const { uid } = await page.evaluate(([name, address]) => signInHeld(name, address), ['Builder One', email] as const);
    // Another browser, with its own storage, signs in to the same account.
    const elsewhere = await app.page(host.url);
    await elsewhere.waitForFunction(() => 'signInExisting' in window);
    assert.equal(await elsewhere.evaluate(([address]) => signInExisting(address, 'secret-pw'), [email] as const), uid);
    const tick = await app.pyric(['sandbox', 'advanceClock', '--ms', '2000']);
    assert.equal(tick.code, 0, tick.output);

    await page.evaluate(() => changeOwnPassword('changed-own-pw'));
    await page.reload();
    await page.waitForFunction(() => 'restoredUid' in window);
    assert.equal(await page.evaluate(() => restoredUid()), uid);
    assert.deepEqual(await page.evaluate(() => forceRefresh()), { code: null, currentUid: uid, lastAuthState: uid });

    const refused = await elsewhere.evaluate(() => forceRefresh());
    assert.deepEqual(refused, { code: 'auth/user-token-expired', currentUid: null, lastAuthState: null });
  });
});
