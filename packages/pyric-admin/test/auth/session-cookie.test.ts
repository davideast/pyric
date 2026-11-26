import { afterEach, describe, expect, it } from 'bun:test';
import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getClock,
  idTokenAudience,
  mintIdToken,
  SANDBOX_PROJECT_ID,
} from 'pyric/sandbox/internal';
import {
  createUserWithEmailAndPassword,
  getAuth as getClientAuth,
  sandbox as clientAuthSandbox,
  signInWithCustomToken,
} from 'pyric/auth';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getAuth } from '../../src/auth/index.js';
import {
  assertSessionCookieArgument,
  SESSION_COOKIE_ISSUER_PREFIX,
  verifySandboxSessionCookie,
} from '../../src/auth/session-cookie.js';

const COOKIE_DOCS =
  ' See https://firebase.google.com/docs/auth/admin/manage-cookies for details on how to retrieve a session cookie.';
const COOKIE_PROJECT_MATCH =
  ' Make sure the session cookie comes from the same Firebase project as the service account used to authenticate this SDK.';
const BAD_COOKIE_SIGNATURE = `Firebase session cookie has invalid signature.${COOKIE_DOCS}`;
const DECODE_COOKIE_FAILED = `Decoding Firebase session cookie failed. Make sure you passed the entire string JWT which represents a session cookie.${COOKIE_DOCS}`;

function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function unsignedJwt(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
): string {
  return `${segment(header)}.${segment(claims)}.c2lnbmF0dXJl`;
}

function productionShapedSessionCookie(projectId: string, nowSec: number): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomBytes(20).toString('hex');
  const claims = {
    iss: `${SESSION_COOKIE_ISSUER_PREFIX}${projectId}`,
    aud: projectId,
    sub: 'production-uid',
    user_id: 'production-uid',
    auth_time: nowSec,
    iat: nowSec,
    exp: nowSec + 3600,
    firebase: { identities: {}, sign_in_provider: 'password' },
  };
  const input = `${segment({ alg: 'RS256', kid, typ: 'JWT' })}.${segment(claims)}`;
  const signature = createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url');
  return `${input}.${signature}`;
}

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('pyric-admin/auth session cookies', () => {
  it('enforces duration bounds, ID token validity, and exact claim/int64 preservation', async () => {
    const sandbox = initializeSandbox();
    const startMs = Date.UTC(2026, 6, 1, 12, 0, 0);
    getClock(sandbox).set(startMs);
    const app = initializeApp({ sandbox, projectId: 'demo-ssr' }, 'cookie-claims');
    const auth = getAuth(app);
    const clientAuth = getClientAuth(sandbox);
    clientAuthSandbox.setProjectIdSource(clientAuth, () => 'demo-ssr');

    await auth.createUser({
      uid: 'u-ssr',
      email: 'ssr@example.com',
      password: 'secret-password',
      emailVerified: true,
    });
    await auth.setCustomUserClaims('u-ssr', {
      role: 'editor',
      orgId: 9_007_199_254_740_993n,
    });
    const customToken = await auth.createCustomToken('u-ssr');
    const { user } = await signInWithCustomToken(clientAuth, customToken);
    const signInSec = Math.floor(startMs / 1000);

    // Advance 10 minutes before minting the cookie so iat != auth_time.
    getClock(sandbox).advance(10 * 60 * 1000);
    const idToken = await user.getIdToken(true);
    const mintSec = Math.floor(getClock(sandbox).now() / 1000);

    // Duration bounds (5 min to 14 days, floored to whole seconds).
    await expect(
      auth.createSessionCookie(idToken, { expiresIn: 299_999 }),
    ).rejects.toMatchObject({ code: 'auth/invalid-session-cookie-duration' });
    await expect(
      auth.createSessionCookie(idToken, { expiresIn: 1_209_601_000 }),
    ).rejects.toMatchObject({ code: 'auth/invalid-session-cookie-duration' });
    await expect(
      auth.createSessionCookie(idToken, { expiresIn: Number.NaN }),
    ).rejects.toMatchObject({ code: 'auth/invalid-session-cookie-duration' });
    await expect(
      auth.createSessionCookie('', { expiresIn: 300_000 }),
    ).rejects.toMatchObject({ code: 'auth/invalid-id-token' });

    const fiveDaysMs = 5 * 24 * 60 * 60 * 1000;
    const cookie = await auth.createSessionCookie(idToken, { expiresIn: fiveDaysMs });
    const maxBoundaryCookie = await auth.createSessionCookie(idToken, {
      expiresIn: 1_209_600_999,
    });
    const maxDecoded = await auth.verifySessionCookie(maxBoundaryCookie);
    expect(maxDecoded.exp - maxDecoded.iat).toBe(1_209_600);

    // After 2 hours the original ID token is expired, while the 5-day cookie still verifies.
    getClock(sandbox).advance(2 * 60 * 60 * 1000);
    await expect(auth.verifyIdToken(idToken)).rejects.toMatchObject({
      code: 'auth/id-token-expired',
    });
    await expect(
      auth.createSessionCookie(idToken, { expiresIn: 300_000 }),
    ).rejects.toMatchObject({ code: 'auth/id-token-expired' });

    const decoded = await auth.verifySessionCookie(cookie, true);
    expect(decoded.uid).toBe('u-ssr');
    expect(decoded.sub).toBe('u-ssr');
    expect(decoded.aud).toBe('demo-ssr');
    expect(decoded.iss).toBe('https://session.firebase.google.com/demo-ssr');
    expect(decoded.auth_time).toBe(signInSec);
    expect(decoded.iat).toBe(mintSec);
    expect(decoded.exp).toBe(mintSec + 5 * 24 * 60 * 60);
    expect(decoded.role).toBe('editor');
    expect(decoded.orgId).toBe(9_007_199_254_740_993n);

    // Advance past cookie expiry.
    getClock(sandbox).set((mintSec + 5 * 24 * 60 * 60) * 1000);
    await expect(auth.verifySessionCookie(cookie)).rejects.toMatchObject({
      code: 'auth/session-cookie-expired',
      message: `Firebase session cookie has expired. Get a fresh session cookie from your client app and try again (auth/session-cookie-expired).${COOKIE_DOCS}`,
    });
    await expect(auth.verifySessionCookie(cookie, true)).rejects.toMatchObject({
      code: 'auth/session-cookie-expired',
    });
  });

  it('prevents cross-token substitution even when iss is rewritten or payloads are forged', async () => {
    const sandbox = initializeSandbox();
    const nowMs = Date.UTC(2026, 6, 1, 12, 0, 0);
    const nowSec = Math.floor(nowMs / 1000);
    getClock(sandbox).set(nowMs);
    const auth = getAuth(initializeApp({ sandbox, projectId: 'demo-iso' }, 'cookie-iso'));
    const clientAuth = getClientAuth(sandbox);
    clientAuthSandbox.setProjectIdSource(clientAuth, () => 'demo-iso');

    const { user } = await createUserWithEmailAndPassword(
      clientAuth,
      'iso@example.com',
      'secret-password',
    );
    const idToken = await user.getIdToken();
    const customToken = await auth.createCustomToken(user.uid);
    const cookie = await auth.createSessionCookie(idToken, { expiresIn: 300_000 });

    // Session cookie rejected as ID token and as createSessionCookie input.
    await expect(auth.verifyIdToken(cookie)).rejects.toMatchObject({
      code: 'auth/argument-error',
    });
    await expect(
      auth.createSessionCookie(cookie, { expiresIn: 300_000 }),
    ).rejects.toMatchObject({ code: 'auth/invalid-id-token' });
    await expect(
      auth.createSessionCookie(customToken, { expiresIn: 300_000 }),
    ).rejects.toMatchObject({ code: 'auth/invalid-id-token' });

    // ID token and custom token rejected by verifySessionCookie with exact messages.
    await expect(auth.verifySessionCookie(idToken)).rejects.toMatchObject({
      code: 'auth/argument-error',
      message: `Firebase session cookie has incorrect "iss" (issuer) claim. Expected "https://session.firebase.google.com/demo-iso" but got "https://securetoken.google.com/demo-iso".${COOKIE_PROJECT_MATCH}${COOKIE_DOCS}`,
    });
    await expect(auth.verifySessionCookie(customToken)).rejects.toMatchObject({
      code: 'auth/argument-error',
      message: `verifySessionCookie() expects a session cookie, but was given a custom token.${COOKIE_DOCS}`,
    });

    // Rewriting iss on an ID token or editing cookie claims fails signature check.
    const idParts = idToken.split('.');
    const idWithCookieIss = `${idParts[0]}.${segment({
      aud: 'demo-iso',
      iss: 'https://session.firebase.google.com/demo-iso',
      sub: user.uid,
      iat: nowSec,
      auth_time: nowSec,
      exp: nowSec + 3600,
    })}.${idParts[2]}`;
    await expect(auth.verifySessionCookie(idWithCookieIss)).rejects.toMatchObject({
      code: 'auth/argument-error',
      message: BAD_COOKIE_SIGNATURE,
    });

    const cookieParts = cookie.split('.');
    const forgedCookie = `${cookieParts[0]}.${segment({
      aud: 'demo-iso',
      iss: 'https://session.firebase.google.com/demo-iso',
      sub: 'victim',
      iat: nowSec,
      auth_time: nowSec,
      exp: nowSec + 3600,
    })}.${cookieParts[2]}`;
    await expect(auth.verifySessionCookie(forgedCookie)).rejects.toMatchObject({
      code: 'auth/argument-error',
      message: BAD_COOKIE_SIGNATURE,
    });

    // An ID token signed with the ID token key carrying session cookie iss is still rejected.
    const crossKeyToken = mintIdToken({
      aud: 'demo-iso',
      iss: 'https://session.firebase.google.com/demo-iso',
      sub: user.uid,
      user_id: user.uid,
      iat: nowSec,
      auth_time: nowSec,
      exp: nowSec + 3600,
      firebase: { identities: {}, sign_in_provider: 'password' },
    });
    await expect(auth.verifySessionCookie(crossKeyToken)).rejects.toMatchObject({
      code: 'auth/argument-error',
      message: BAD_COOKIE_SIGNATURE,
    });
  });

  it('checks token structure, project audience, unknown/production kid, and fail-closed inputs', async () => {
    const sandbox = initializeSandbox();
    const nowMs = Date.UTC(2026, 6, 1, 12, 0, 0);
    const nowSec = Math.floor(nowMs / 1000);
    getClock(sandbox).set(nowMs);
    const auth = getAuth(initializeApp({ sandbox, projectId: 'demo-check' }, 'cookie-check'));

    expect(() => assertSessionCookieArgument(42)).toThrow(
      /First argument to verifySessionCookie\(\) must be a Firebase session cookie string/,
    );
    await expect(auth.verifySessionCookie('not-a-jwt')).rejects.toMatchObject({
      code: 'auth/argument-error',
      message: DECODE_COOKIE_FAILED,
    });

    const baseClaims = {
      aud: 'demo-check',
      iss: `${SESSION_COOKIE_ISSUER_PREFIX}demo-check`,
      sub: 'alice',
      iat: nowSec,
      auth_time: nowSec,
      exp: nowSec + 3600,
    };

    await expect(
      auth.verifySessionCookie(unsignedJwt({ alg: 'RS256', typ: 'JWT' }, baseClaims)),
    ).rejects.toMatchObject({
      code: 'auth/argument-error',
      message: `Firebase session cookie has no "kid" claim.${COOKIE_DOCS}`,
    });
    await expect(
      auth.verifySessionCookie(
        unsignedJwt({ alg: 'HS256', kid: 'pyric-sandbox', typ: 'JWT' }, baseClaims),
      ),
    ).rejects.toMatchObject({
      code: 'auth/argument-error',
      message: `Firebase session cookie has incorrect algorithm. Expected "RS256" but got "HS256".${COOKIE_DOCS}`,
    });
    await expect(
      auth.verifySessionCookie(
        unsignedJwt(
          { alg: 'RS256', kid: 'pyric-sandbox', typ: 'JWT' },
          { ...baseClaims, aud: 'other-project' },
        ),
      ),
    ).rejects.toMatchObject({
      code: 'auth/argument-error',
      message: `Firebase session cookie has incorrect "aud" (audience) claim. Expected "demo-check" but got "other-project".${COOKIE_PROJECT_MATCH}${COOKIE_DOCS}`,
    });
    await expect(
      auth.verifySessionCookie(
        unsignedJwt(
          { alg: 'RS256', kid: 'pyric-sandbox', typ: 'JWT' },
          { ...baseClaims, sub: '' },
        ),
      ),
    ).rejects.toMatchObject({
      code: 'auth/argument-error',
      message: `Firebase session cookie has an empty "sub" (subject) claim.${COOKIE_DOCS}`,
    });
    await expect(
      auth.verifySessionCookie(
        unsignedJwt(
          { alg: 'RS256', kid: 'pyric-sandbox', typ: 'JWT' },
          { ...baseClaims, sub: 'x'.repeat(129) },
        ),
      ),
    ).rejects.toMatchObject({
      code: 'auth/argument-error',
      message: `Firebase session cookie has a "sub" (subject) claim longer than 128 characters.${COOKIE_DOCS}`,
    });
    await expect(
      auth.verifySessionCookie(unsignedJwt({ alg: 'RS256', kid: 42, typ: 'JWT' }, baseClaims)),
    ).rejects.toMatchObject({
      code: 'auth/argument-error',
      message:
        'Firebase session cookie has "kid" claim which does not correspond to a known public key. Most likely the session cookie is expired, so get a fresh token from your client app and try again.',
    });

    // Production-shaped session cookie adds PYRIC_MODE_MISMATCH while keeping auth/argument-error.
    const prodCookie = productionShapedSessionCookie('demo-check', nowSec);
    await expect(auth.verifySessionCookie(prodCookie)).rejects.toMatchObject({
      code: 'auth/argument-error',
      pyricCode: 'PYRIC_MODE_MISMATCH',
    });

    // Fail closed on non-finite nowMs or empty projectId.
    await expect(
      verifySandboxSessionCookie('a.b.c', { projectId: '', nowMs }),
    ).rejects.toMatchObject({ code: 'auth/internal-error' });
    await expect(
      verifySandboxSessionCookie('a.b.c', { projectId: SANDBOX_PROJECT_ID, nowMs: Number.NaN }),
    ).rejects.toMatchObject({ code: 'auth/internal-error' });
  });

  it('works without Node Buffer globals (browser/worker fallback parity)', async () => {
    const sandbox = initializeSandbox();
    const nowMs = Date.UTC(2026, 6, 1, 12, 0, 0);
    getClock(sandbox).set(nowMs);
    const auth = getAuth(initializeApp({ sandbox }, 'cookie-no-buffer'));
    const clientAuth = getClientAuth(sandbox);
    const { user } = await createUserWithEmailAndPassword(
      clientAuth,
      'worker@example.com',
      'secret-password',
    );
    const idToken = await user.getIdToken();

    const savedBuffer = globalThis.Buffer;
    try {
      // Simulate a worker/browser realm without Node Buffer.
      (globalThis as { Buffer?: typeof Buffer }).Buffer = undefined;
      const cookie = await auth.createSessionCookie(idToken, { expiresIn: 300_000 });
      const decoded = await auth.verifySessionCookie(cookie, true);
      expect(decoded.uid).toBe(user.uid);
      expect(decoded.email).toBe('worker@example.com');
    } finally {
      globalThis.Buffer = savedBuffer;
    }
  });

  it('rejects createSessionCookie for revoked, disabled, deleted, and wrong-project ID tokens', async () => {
    const sandbox = initializeSandbox();
    const nowMs = Date.UTC(2026, 6, 1, 12, 0, 0);
    const nowSec = Math.floor(nowMs / 1000);
    getClock(sandbox).set(nowMs);
    const auth = getAuth(initializeApp({ sandbox, projectId: 'demo-standing' }, 'cookie-standing'));
    const clientAuth = getClientAuth(sandbox);
    clientAuthSandbox.setProjectIdSource(clientAuth, () => 'demo-standing');

    const { user } = await createUserWithEmailAndPassword(
      clientAuth,
      'standing@example.com',
      'secret-password',
    );
    const idToken = await user.getIdToken();

    const wrongProjectIdToken = mintIdToken({
      ...idTokenAudience('other-project'),
      sub: user.uid,
      user_id: user.uid,
      iat: nowSec,
      auth_time: nowSec,
      exp: nowSec + 3600,
      firebase: { identities: {}, sign_in_provider: 'password' },
    });
    await expect(
      auth.createSessionCookie(wrongProjectIdToken, { expiresIn: 300_000 }),
    ).rejects.toMatchObject({ code: 'auth/invalid-id-token' });

    // Disabled user cannot mint a session cookie.
    await auth.updateUser(user.uid, { disabled: true });
    await expect(
      auth.createSessionCookie(idToken, { expiresIn: 300_000 }),
    ).rejects.toMatchObject({ code: 'auth/user-disabled' });
    await auth.updateUser(user.uid, { disabled: false });

    // Revoked ID token cannot mint a session cookie.
    getClock(sandbox).advance(2000);
    await auth.revokeRefreshTokens(user.uid);
    await expect(
      auth.createSessionCookie(idToken, { expiresIn: 300_000 }),
    ).rejects.toMatchObject({ code: 'auth/id-token-expired' });

    // Deleted user cannot mint a session cookie.
    await auth.deleteUser(user.uid);
    await expect(
      auth.createSessionCookie(idToken, { expiresIn: 300_000 }),
    ).rejects.toMatchObject({ code: 'auth/user-not-found' });
  });
});
