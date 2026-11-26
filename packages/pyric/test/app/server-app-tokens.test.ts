import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import 'fake-indexeddb/auto';
import {
  deleteApp,
  initializeApp,
  initializeServerApp,
  type FirebaseOptions,
} from '../../src/app/index.js';
import { resetAppRegistryForTests } from '../../src/app/internal.js';
import { sandboxForApp } from '../../src/app/runtime.js';
import {
  authStateFromServerIdToken,
  validateServerTokenTTL,
} from '../../src/app/server-app-tokens.js';
import {
  createUserWithEmailAndPassword,
  getAuth,
  sandbox as authSandbox,
} from '../../src/auth/index.js';
import { doc, getDoc, getFirestore, setDoc } from '../../src/firestore/index.js';
import { setRules } from '../../src/firestore/sandbox-controls.js';
import { getClock, initializeSandbox, type LocalSandbox } from '../../src/sandbox/index.js';
import {
  authAccountsFor,
  mintAppCheckToken,
  mintCustomToken,
  mintIdToken,
  signSandboxJwtSync,
} from 'pyric/sandbox/internal';
import { SANDBOX_JWT_KID } from '../../src/sandbox/internal/sandbox-jwt.js';

const ID_TOKEN_KEY = 'pyric-sandbox-id-token-signing-key';

const OPTS: FirebaseOptions = {
  apiKey: 'fake-api-key',
  projectId: 'demo-server-tokens',
  appId: '1:123456789012:web:servertokens01',
};

function makeClaims(
  uid: string,
  nowSec: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    aud: OPTS.projectId,
    iss: `https://securetoken.google.com/${OPTS.projectId}`,
    sub: uid,
    user_id: uid,
    auth_time: nowSec,
    iat: nowSec,
    exp: nowSec + 3600,
    firebase: {
      identities: {},
      sign_in_provider: 'password',
    },
    ...overrides,
  };
}

function makeSignedToken(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
): string {
  return signSandboxJwtSync(ID_TOKEN_KEY, header, claims);
}

beforeEach(async () => {
  await resetAppRegistryForTests();
});

afterEach(async () => {
  await resetAppRegistryForTests();
});

describe('authStateFromServerIdToken adversarial JWT matrix', () => {
  it('rejects non-RS256 alg, missing/empty/wrong kid, wrong signing key, and malformed JWTs', async () => {
    const sb = initializeSandbox();
    const auth = getAuth(sb);
    const cred = await createUserWithEmailAndPassword(auth, 'header@example.com', 'password123');
    const uid = cred.user.uid;
    const nowSec = Math.floor(getClock(sb).now() / 1000);
    const validClaims = makeClaims(uid, nowSec);

    const appCheck = await mintAppCheckToken(
      { appId: OPTS.appId ?? '', projectId: OPTS.projectId ?? '' },
      3600,
    );
    const customToken = await mintCustomToken(uid, OPTS.projectId ?? '', { role: 'editor' });

    const validToken = mintIdToken(validClaims);
    const validParts = validToken.split('.');
    const tamperedSig = `${validParts[0]}.${validParts[1]}.tampered-signature`;
    const emptySig = `${validParts[0]}.${validParts[1]}.`;

    const invalidCases: Array<[string, string]> = [
      ['empty string', ''],
      ['plain text', 'not-a-jwt'],
      ['two segments', `${validParts[0]}.${validParts[1]}`],
      ['four segments', `${validToken}.extra`],
      ['empty signature', emptySig],
      ['tampered signature', tamperedSig],
      ['alg=none', makeSignedToken({ alg: 'none', kid: SANDBOX_JWT_KID, typ: 'JWT' }, validClaims)],
      ['alg=HS256', makeSignedToken({ alg: 'HS256', kid: SANDBOX_JWT_KID, typ: 'JWT' }, validClaims)],
      ['missing alg', makeSignedToken({ kid: SANDBOX_JWT_KID, typ: 'JWT' }, validClaims)],
      ['missing kid', makeSignedToken({ alg: 'RS256', typ: 'JWT' }, validClaims)],
      ['empty kid', makeSignedToken({ alg: 'RS256', kid: '', typ: 'JWT' }, validClaims)],
      ['null kid', makeSignedToken({ alg: 'RS256', kid: null, typ: 'JWT' }, validClaims)],
      ['numeric kid', makeSignedToken({ alg: 'RS256', kid: 0, typ: 'JWT' }, validClaims)],
      ['false kid', makeSignedToken({ alg: 'RS256', kid: false, typ: 'JWT' }, validClaims)],
      ['wrong kid', makeSignedToken({ alg: 'RS256', kid: 'prod-rsa-key-1', typ: 'JWT' }, validClaims)],
      ['App Check token', appCheck.token],
      ['Custom token', customToken],
    ];

    for (const [label, token] of invalidCases) {
      expect(authStateFromServerIdToken(token, OPTS.projectId, sb), label).toBeNull();
    }

    const accepted = authStateFromServerIdToken(validToken, OPTS.projectId, sb);
    expect(accepted).not.toBeNull();
    expect(accepted?.uid).toBe(uid);
  });

  it('validates iss, aud, sub, user_id, and firebase claim structure strictly', async () => {
    const sb = initializeSandbox();
    const auth = getAuth(sb);
    const cred = await createUserWithEmailAndPassword(auth, 'claims@example.com', 'password123');
    const uid = cred.user.uid;
    const nowSec = Math.floor(getClock(sb).now() / 1000);

    const claimsWithoutAud = makeClaims(uid, nowSec);
    delete claimsWithoutAud.aud;
    const claimsWithoutIss = makeClaims(uid, nowSec);
    delete claimsWithoutIss.iss;
    const claimsWithoutSub = makeClaims(uid, nowSec);
    delete claimsWithoutSub.sub;
    const claimsWithoutExp = makeClaims(uid, nowSec);
    delete claimsWithoutExp.exp;

    const invalidCases: Array<[string, Record<string, unknown>]> = [
      ['missing aud', claimsWithoutAud],
      ['empty aud', makeClaims(uid, nowSec, { aud: '' })],
      ['wrong aud', makeClaims(uid, nowSec, { aud: 'other-project' })],
      ['non-string aud', makeClaims(uid, nowSec, { aud: 42 })],
      ['missing iss', claimsWithoutIss],
      ['empty iss', makeClaims(uid, nowSec, { iss: '' })],
      ['wrong iss host', makeClaims(uid, nowSec, { iss: `https://evil.example/${OPTS.projectId}` })],
      ['wrong iss project', makeClaims(uid, nowSec, { iss: 'https://securetoken.google.com/other-project' })],
      ['missing sub even with user_id', claimsWithoutSub],
      ['empty sub', makeClaims(uid, nowSec, { sub: '', user_id: '' })],
      ['sub longer than 128 chars', makeClaims('a'.repeat(129), nowSec)],
      ['mismatched user_id and sub', makeClaims(uid, nowSec, { sub: uid, user_id: 'other-uid' })],
      ['non-string user_id', makeClaims(uid, nowSec, { user_id: 99 })],
      ['missing exp', claimsWithoutExp],
      ['non-number exp', makeClaims(uid, nowSec, { exp: String(nowSec + 3600) })],
      ['non-number nbf', makeClaims(uid, nowSec, { nbf: String(nowSec - 10) })],
      ['non-number auth_time', makeClaims(uid, nowSec, { auth_time: String(nowSec) })],
      ['non-number iat', makeClaims(uid, nowSec, { iat: String(nowSec) })],
      ['malformed firebase claim', makeClaims(uid, nowSec, { firebase: 'invalid' })],
      ['empty firebase tenant', makeClaims(uid, nowSec, { firebase: { identities: {}, tenant: '' } })],
      ['non-string firebase tenant', makeClaims(uid, nowSec, { firebase: { identities: {}, tenant: 123 } })],
    ];

    for (const [label, claims] of invalidCases) {
      const token = mintIdToken(claims);
      expect(authStateFromServerIdToken(token, OPTS.projectId, sb), label).toBeNull();
    }

    // Without expectedProjectId, aud and iss must still be present and consistent.
    expect(authStateFromServerIdToken(mintIdToken(claimsWithoutAud), undefined, sb)).toBeNull();
    expect(
      authStateFromServerIdToken(
        mintIdToken(makeClaims(uid, nowSec, { iss: 'https://securetoken.google.com/mismatch' })),
        undefined,
        sb,
      ),
    ).toBeNull();
    expect(
      authStateFromServerIdToken(mintIdToken(makeClaims(uid, nowSec)), undefined, sb)?.uid,
    ).toBe(uid);
  });

  it('evaluates exp and nbf against the sandbox clock rather than raw Date.now()', async () => {
    const sb = initializeSandbox();
    const clock = getClock(sb);
    const fixedStartMs = 1_750_000_000_000;
    clock.set(fixedStartMs);

    const auth = getAuth(sb);
    const cred = await createUserWithEmailAndPassword(auth, 'clock@example.com', 'password123');
    const uid = cred.user.uid;
    const baseSec = Math.floor(fixedStartMs / 1000);

    // Token is in the distant past relative to Date.now() if wall clock is ahead,
    // or valid on the frozen sandbox clock.
    const validOnClock = mintIdToken(
      makeClaims(uid, baseSec, { nbf: baseSec, exp: baseSec + 120 }),
    );
    expect(authStateFromServerIdToken(validOnClock, OPTS.projectId, sb)?.uid).toBe(uid);

    // Future nbf relative to sandbox clock must be rejected.
    const notYetValid = mintIdToken(
      makeClaims(uid, baseSec, { nbf: baseSec + 60, exp: baseSec + 3600 }),
    );
    expect(authStateFromServerIdToken(notYetValid, OPTS.projectId, sb)).toBeNull();

    // Advancing sandbox clock to nbf makes the token valid.
    clock.advance(60_000);
    expect(authStateFromServerIdToken(notYetValid, OPTS.projectId, sb)?.uid).toBe(uid);

    // Advancing sandbox clock to exact exp rejects validOnClock (exp * 1000 <= nowMs).
    clock.advance(60_000);
    expect(authStateFromServerIdToken(validOnClock, OPTS.projectId, sb)).toBeNull();

    // validateServerTokenTTL also respects caller-supplied sandbox clock nowMs.
    const logged: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map((item) => String(item)).join(' '));
    };
    try {
      validateServerTokenTTL(validOnClock, 'authIdToken', clock.now());
      expect(logged).toEqual([
        'FirebaseServerApp authIdToken is invalid: the token has expired.',
      ]);
      logged.length = 0;
      validateServerTokenTTL(validOnClock, 'authIdToken', fixedStartMs + 30_000);
      expect(logged).toEqual([]);
    } finally {
      console.error = origError;
    }
  });

  it('checks revocation against claims.auth_time and rejects disabled, deleted, and unknown accounts', async () => {
    const sb = initializeSandbox();
    const clock = getClock(sb);
    const auth = getAuth(sb);
    const cred = await createUserWithEmailAndPassword(auth, 'standing@example.com', 'password123');
    const uid = cred.user.uid;
    const signInSec = Math.floor(clock.now() / 1000);

    // Advance 10s and revoke refresh tokens.
    clock.advance(10_000);
    const accounts = authAccountsFor(sb);
    expect(accounts).toBeDefined();
    accounts?.revokeRefreshTokens(uid);

    // Refreshed token has iat AFTER revocation, but auth_time BEFORE revocation -> must reject.
    const refreshedRevoked = mintIdToken(
      makeClaims(uid, signInSec, {
        auth_time: signInSec,
        iat: signInSec + 20,
        exp: signInSec + 3600,
      }),
    );
    expect(authStateFromServerIdToken(refreshedRevoked, OPTS.projectId, sb)).toBeNull();

    // Token omitting auth_time on a revoked account must also fail closed.
    const noAuthTimeClaims = makeClaims(uid, signInSec, {
      iat: signInSec + 20,
      exp: signInSec + 3600,
    });
    delete noAuthTimeClaims.auth_time;
    expect(authStateFromServerIdToken(mintIdToken(noAuthTimeClaims), OPTS.projectId, sb)).toBeNull();

    // Token minted after re-authentication (auth_time >= tokensValidAfterMs) is accepted.
    const reauthedSec = Math.floor(clock.now() / 1000) + 1;
    const freshToken = mintIdToken(
      makeClaims(uid, reauthedSec, {
        auth_time: reauthedSec,
        iat: reauthedSec,
        exp: reauthedSec + 3600,
      }),
    );
    expect(authStateFromServerIdToken(freshToken, OPTS.projectId, sb)?.uid).toBe(uid);

    // Disabled account must be rejected.
    authSandbox.updateUser(auth, uid, { disabled: true });
    expect(authStateFromServerIdToken(freshToken, OPTS.projectId, sb)).toBeNull();

    // Re-enabling restores acceptance; deleting rejects.
    authSandbox.updateUser(auth, uid, { disabled: false });
    expect(authStateFromServerIdToken(freshToken, OPTS.projectId, sb)?.uid).toBe(uid);
    authSandbox.deleteUser(auth, uid);
    expect(authStateFromServerIdToken(freshToken, OPTS.projectId, sb)).toBeNull();

    // Unknown/unrecorded uid must be rejected when Auth account store is active.
    const ghostToken = mintIdToken(makeClaims('ghost-uid', reauthedSec));
    expect(authStateFromServerIdToken(ghostToken, OPTS.projectId, sb)).toBeNull();
  });

  it('preserves normalized rules token claims and tenant in initializeServerApp Firestore rules', async () => {
    const clientApp = initializeApp(OPTS);
    const sandbox = sandboxForApp(clientApp) as LocalSandbox;
    const clock = getClock(sandbox);
    setRules(
      sandbox,
      `
      rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /tenants/{tenantId}/items/{uid} {
            allow read, write: if request.auth != null
              && request.auth.uid == uid
              && request.auth.token.firebase.tenant == tenantId
              && request.auth.token.role == 'editor';
          }
        }
      }
      `,
    );

    const auth = getAuth(clientApp);
    auth.tenantId = 'tenant-acme';
    const cred = await createUserWithEmailAndPassword(auth, 'tenant@example.com', 'password123');
    const uid = cred.user.uid;
    const nowSec = Math.floor(clock.now() / 1000);

    const tenantClaims = makeClaims(uid, nowSec, {
      role: 'editor',
      firebase: {
        identities: { email: ['tenant@example.com'] },
        sign_in_provider: 'password',
        tenant: 'tenant-acme',
      },
    });
    const validToken = mintIdToken(tenantClaims);

    const extracted = authStateFromServerIdToken(validToken, OPTS.projectId, sandbox);
    expect(extracted).not.toBeNull();
    expect(extracted?.uid).toBe(uid);
    expect(extracted?.tenant).toBe('tenant-acme');
    expect((extracted?.token?.firebase as Record<string, unknown>)?.tenant).toBe('tenant-acme');
    expect(extracted?.token?.role).toBe('editor');

    const validServerApp = initializeServerApp(OPTS, { authIdToken: validToken });
    const db = getFirestore(validServerApp);
    await setDoc(doc(db, 'tenants', 'tenant-acme', 'items', uid), { ok: true });
    const snap = await getDoc(doc(db, 'tenants', 'tenant-acme', 'items', uid));
    expect(snap.data()).toEqual({ ok: true });

    // Adversarial tokens must fail closed as unauthenticated in initializeServerApp.
    const origError = console.error;
    console.error = () => {};
    try {
      const algNoneToken = makeSignedToken(
        { alg: 'none', kid: SANDBOX_JWT_KID, typ: 'JWT' },
        tenantClaims,
      );
      const algNoneApp = initializeServerApp(OPTS, { authIdToken: algNoneToken });
      await expect(
        setDoc(doc(getFirestore(algNoneApp), 'tenants', 'tenant-acme', 'items', uid), { bad: 1 }),
      ).rejects.toThrow();
      await deleteApp(algNoneApp);

      const futureNbfToken = mintIdToken({ ...tenantClaims, nbf: nowSec + 300 });
      const futureNbfApp = initializeServerApp(OPTS, { authIdToken: futureNbfToken });
      await expect(
        setDoc(doc(getFirestore(futureNbfApp), 'tenants', 'tenant-acme', 'items', uid), { bad: 2 }),
      ).rejects.toThrow();
      await deleteApp(futureNbfApp);

      // Revoke tokens and confirm a refreshed token with old auth_time is denied.
      clock.advance(10_000);
      authAccountsFor(sandbox)?.revokeRefreshTokens(uid);
      const revokedRefreshed = mintIdToken({
        ...tenantClaims,
        auth_time: nowSec,
        iat: nowSec + 15,
        exp: nowSec + 3600,
      });
      const revokedApp = initializeServerApp(OPTS, { authIdToken: revokedRefreshed });
      await expect(
        setDoc(doc(getFirestore(revokedApp), 'tenants', 'tenant-acme', 'items', uid), { bad: 3 }),
      ).rejects.toThrow();
      await deleteApp(revokedApp);
    } finally {
      console.error = origError;
    }

    await deleteApp(validServerApp);
  });
});
