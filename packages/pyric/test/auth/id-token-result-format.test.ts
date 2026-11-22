/**
 * Regression tests for `#1956`: `getIdTokenResult()` formats `authTime`,
 * `issuedAtTime`, and `expirationTime` as UTC date strings matching
 * `Date.prototype.toUTCString()`, and always includes `signInSecondFactor`.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getClock } from 'pyric/sandbox/internal';
import {
  getAuth,
  getIdTokenResult,
  GoogleAuthProvider,
  sandbox as authSandbox,
  sendSignInLinkToEmail,
  signInAnonymously,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signInWithEmailLink,
  signInWithPopup,
  type IdTokenResult,
} from '../../src/auth/index.js';
import { mintCustomTokenFor } from '../../src/auth/internal.js';

const UTC_DATE_STRING_RE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const EXPECTED_RESULT_KEYS = [
  'authTime',
  'claims',
  'expirationTime',
  'issuedAtTime',
  'signInProvider',
  'signInSecondFactor',
  'token',
];

function expectUtcTokenResultShape(
  result: IdTokenResult,
  expectedProvider: string | null,
): void {
  expect(Object.keys(result).sort()).toEqual(EXPECTED_RESULT_KEYS);
  expect(Object.hasOwn(result, 'signInSecondFactor')).toBe(true);
  expect(result.signInSecondFactor).toBeNull();
  expect(result.signInProvider).toBe(expectedProvider);

  expect(result.authTime).toMatch(UTC_DATE_STRING_RE);
  expect(result.issuedAtTime).toMatch(UTC_DATE_STRING_RE);
  expect(result.expirationTime).toMatch(UTC_DATE_STRING_RE);

  const authTimeClaim = Number(result.claims['auth_time']);
  const iatClaim = Number(result.claims['iat']);
  const expClaim = Number(result.claims['exp']);
  expect(result.authTime).toBe(new Date(authTimeClaim * 1000).toUTCString());
  expect(result.issuedAtTime).toBe(new Date(iatClaim * 1000).toUTCString());
  expect(result.expirationTime).toBe(new Date(expClaim * 1000).toUTCString());
  expect(expClaim - iatClaim).toBe(3600);
}

describe('getIdTokenResult UTC timestamps and signInSecondFactor (#1956)', () => {
  it('formats times as UTC strings and includes signInSecondFactor across every sign-in kind', async () => {
    const sandbox = initializeSandbox();
    try {
      // Non-zero milliseconds verify floor-to-second alignment with JWT claims.
      getClock(sandbox).set(Date.UTC(2026, 10, 21, 12, 34, 56, 789));
      const auth = getAuth(sandbox);

      // 1. Anonymous sign-in
      const anon = await signInAnonymously(auth);
      expectUtcTokenResultShape(await anon.user.getIdTokenResult(), 'anonymous');
      expectUtcTokenResultShape(await getIdTokenResult(anon.user), 'anonymous');

      // 2. Email/password sign-in + forced refresh
      authSandbox.createUser(auth, {
        uid: 'pw-user',
        email: 'pw@example.com',
        password: 'password123',
      });
      const pw = await signInWithEmailAndPassword(auth, 'pw@example.com', 'password123');
      const pwBefore = await pw.user.getIdTokenResult();
      expectUtcTokenResultShape(pwBefore, 'password');

      getClock(sandbox).advance(5_000);
      const pwRefreshed = await pw.user.getIdTokenResult(true);
      expectUtcTokenResultShape(pwRefreshed, 'password');
      expect(pwRefreshed.authTime).toBe(pwBefore.authTime);
      expect(pwRefreshed.issuedAtTime).not.toBe(pwBefore.issuedAtTime);

      // 3. Custom token sign-in
      const customToken = mintCustomTokenFor(auth, 'custom-u', { role: 'tester' });
      const custom = await signInWithCustomToken(auth, customToken);
      expectUtcTokenResultShape(await custom.user.getIdTokenResult(), 'custom');

      // 4. Email link sign-in
      await sendSignInLinkToEmail(auth, 'link@example.com', {
        url: 'https://app.example.com/finish',
        handleCodeInApp: true,
      });
      const mail = authSandbox.takeAuthMail(auth);
      expect(mail).not.toBeNull();
      if (mail === null) {
        throw new Error('Expected outbound sign-in link mail');
      }
      const linkCred = await signInWithEmailLink(auth, 'link@example.com', mail.link);
      expectUtcTokenResultShape(await linkCred.user.getIdTokenResult(), 'password');

      // 5. Federated provider popup sign-in
      authSandbox.setAuthProviderConfig(auth, { 'google.com': true });
      authSandbox.mockSignInResult(auth, {
        user: { uid: 'google-u', email: 'g@example.com', displayName: 'G User' },
        providerId: 'google.com',
      });
      const popup = await signInWithPopup(auth, new GoogleAuthProvider());
      expectUtcTokenResultShape(await popup.user.getIdTokenResult(), 'google.com');
    } finally {
      sandbox.dispose();
    }
  });
});
