/**
 * Unsigned and OIDC JWT decode fallback in `signInWithCredential`.
 *
 * When no `sandbox.mockSignInResult` override is staged for a federated
 * provider, `signInWithCredential` decodes a well-formed 2- or 3-segment OIDC
 * JWT `idToken` (`sub`, `email`, `email_verified`, `name`, `picture`) just as
 * the Firebase Auth Emulator does, while keeping `mockSignInResult` precedence
 * and throwing `auth/no-mock-configured` for opaque or malformed tokens.
 */

import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { encodeJson } from 'pyric/sandbox/internal';
import {
  beforeAuthStateChanged,
  createUserWithEmailAndPassword,
  getAdditionalUserInfo,
  getAuth,
  GoogleAuthProvider,
  OAuthProvider,
  sandbox as authSandbox,
  signInWithCredential,
  signOut,
  type User,
} from '../../../src/auth/index.js';
import { decodeOidcIdTokenClaims, resolveOidcJwtIdentity } from '../../../src/auth/internal.js';

function makeUnsignedJwt(
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'none', typ: 'JWT' },
  signatureSegment: string | null = '',
): string {
  const head = encodeJson(header);
  const body = encodeJson(claims);
  if (signatureSegment === null) {
    return `${head}.${body}`;
  }
  return `${head}.${body}.${signatureSegment}`;
}

function makeFakeMockUser(uid: string, email: string): User {
  return {
    uid,
    email,
    emailVerified: true,
    displayName: 'Staged Override',
    isAnonymous: false,
    photoURL: 'https://example.com/staged.png',
    phoneNumber: null,
    providerId: 'firebase',
    tenantId: null,
    providerData: [],
    metadata: {},
    refreshToken: `refresh-${uid}`,
    getIdToken: async () => `mock-token-${uid}`,
    getIdTokenResult: async () => ({
      token: `mock-token-${uid}`,
      claims: { sub: uid, user_id: uid, email },
      authTime: new Date(0).toUTCString(),
      issuedAtTime: new Date(0).toUTCString(),
      expirationTime: new Date(3_600_000).toUTCString(),
      signInProvider: 'google.com',
      signInSecondFactor: null,
    }),
    reload: async () => {},
    delete: async () => {},
    toJSON: () => ({ uid, email }),
  };
}

async function catchCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
    return String(error);
  }
  return 'resolved';
}

describe('decodeOidcIdTokenClaims', () => {
  it('decodes 2-segment and 3-segment OIDC JWTs and maps standard profile claims', () => {
    const twoSegment = makeUnsignedJwt(
      {
        sub: 'google-sub-101',
        email: 'pilot@example.com',
        email_verified: true,
        name: 'Ada Pilot',
        picture: 'https://example.com/ada.png',
      },
      { alg: 'none' },
      null,
    );
    const decodedTwo = decodeOidcIdTokenClaims(twoSegment);
    expect(decodedTwo).toEqual({
      sub: 'google-sub-101',
      email: 'pilot@example.com',
      emailVerified: true,
      displayName: 'Ada Pilot',
      photoURL: 'https://example.com/ada.png',
      claims: {
        sub: 'google-sub-101',
        email: 'pilot@example.com',
        email_verified: true,
        name: 'Ada Pilot',
        picture: 'https://example.com/ada.png',
      },
    });

    const threeSegmentSigned = makeUnsignedJwt(
      {
        sub: 'google-sub-202',
        email: 'grace@example.com',
        email_verified: 'false',
      },
      { alg: 'RS256', kid: 'k1' },
      'ZmFrZS1zaWduYXR1cmU',
    );
    const decodedThree = decodeOidcIdTokenClaims(threeSegmentSigned);
    expect(decodedThree?.sub).toBe('google-sub-202');
    expect(decodedThree?.email).toBe('grace@example.com');
    expect(decodedThree?.emailVerified).toBe(false);
    expect(decodedThree?.displayName).toBeNull();
    expect(decodedThree?.photoURL).toBeNull();
  });

  it('normalizes standard base64 padding and alphabet characters', () => {
    const stdHeader = Buffer.from(JSON.stringify({ alg: 'none' }), 'utf8').toString('base64');
    const stdPayload = Buffer.from(
      JSON.stringify({ sub: 'sub/with+chars?x=1', email: 'b64@example.com', email_verified: 'true' }),
      'utf8',
    ).toString('base64');
    const decoded = decodeOidcIdTokenClaims(`${stdHeader}.${stdPayload}.`);
    expect(decoded?.sub).toBe('sub/with+chars?x=1');
    expect(decoded?.email).toBe('b64@example.com');
    expect(decoded?.emailVerified).toBe(true);
  });

  it('returns null for opaque tokens, malformed segments, or payloads missing a non-empty sub', () => {
    expect(decodeOidcIdTokenClaims('')).toBeNull();
    expect(decodeOidcIdTokenClaims('opaque-id-token')).toBeNull();
    expect(decodeOidcIdTokenClaims('a.b.c.d')).toBeNull();
    expect(decodeOidcIdTokenClaims('.eyJzdWIiOiJ1MSJ9.')).toBeNull();
    expect(decodeOidcIdTokenClaims('not-json.eyJzdWIiOiJ1MSJ9.')).toBeNull();
    expect(decodeOidcIdTokenClaims(`${encodeJson({ alg: 'none' })}.${encodeJson({ email: 'no-sub@example.com' })}.`)).toBeNull();
    expect(decodeOidcIdTokenClaims(`${encodeJson({ alg: 'none' })}.${encodeJson({ sub: '   ' })}.`)).toBeNull();
    expect(decodeOidcIdTokenClaims(`${encodeJson({ alg: 'none' })}.${encodeJson(['array'])}.`)).toBeNull();
  });
});

describe('signInWithCredential OIDC JWT fallback', () => {
  it('creates a Google user from an unsigned OIDC JWT when no mockSignInResult is staged, then reuses it on repeat sign-in', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const jwt = makeUnsignedJwt({
      sub: 'google-uid-42',
      email: 'dana@example.com',
      email_verified: true,
      name: 'Dana Sterling',
      picture: 'https://example.com/dana-v1.png',
    });

    const first = await signInWithCredential(auth, GoogleAuthProvider.credential(jwt));
    expect(first.providerId).toBe('google.com');
    expect(first.user).toBe(auth.currentUser);
    expect(first.user.uid).toBe('google-uid-42');
    expect(first.user.email).toBe('dana@example.com');
    expect(first.user.emailVerified).toBe(true);
    expect(first.user.displayName).toBe('Dana Sterling');
    expect(first.user.photoURL).toBe('https://example.com/dana-v1.png');
    expect(first.user.providerData.map((p) => p.providerId)).toEqual(['google.com']);
    expect(getAdditionalUserInfo(first)?.isNewUser).toBe(true);
    expect(getAdditionalUserInfo(first)?.providerId).toBe('google.com');

    const tokenResult = await first.user.getIdTokenResult();
    expect(tokenResult.signInProvider).toBe('google.com');
    expect(tokenResult.claims['email']).toBe('dana@example.com');
    expect(tokenResult.claims['email_verified']).toBe(true);

    await signOut(auth);

    const updatedJwt = makeUnsignedJwt({
      sub: 'google-uid-42',
      email: 'dana@example.com',
      email_verified: true,
      name: 'Dana Updated',
      picture: 'https://example.com/dana-v2.png',
    });
    const second = await signInWithCredential(auth, GoogleAuthProvider.credential(updatedJwt));
    expect(second.user.uid).toBe('google-uid-42');
    expect(second.user.displayName).toBe('Dana Updated');
    expect(second.user.photoURL).toBe('https://example.com/dana-v2.png');
    expect(getAdditionalUserInfo(second)?.isNewUser).toBe(false);
    expect(authSandbox.listUsers(auth)).toHaveLength(1);
  });

  it('preserves explicit mockSignInResult precedence over an OIDC JWT idToken', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const jwt = makeUnsignedJwt({
      sub: 'jwt-sub-ignored',
      email: 'jwt@example.com',
      email_verified: true,
      name: 'JWT Identity',
    });

    authSandbox.mockSignInResult(auth, {
      user: makeFakeMockUser('staged-winner-uid', 'staged@example.com'),
      providerId: 'google.com',
      operationType: 'signIn',
    });

    const first = await signInWithCredential(auth, GoogleAuthProvider.credential(jwt));
    expect(first.user.uid).toBe('staged-winner-uid');
    expect(first.user.email).toBe('staged@example.com');

    await signOut(auth);

    // Once the single-use mockSignInResult is consumed, the next call falls back to decoding the JWT.
    const second = await signInWithCredential(auth, GoogleAuthProvider.credential(jwt));
    expect(second.user.uid).toBe('jwt-sub-ignored');
    expect(second.user.email).toBe('jwt@example.com');
  });

  it('links onto an existing same-email account in the same tenant without overwriting unverified password status', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const createdPw = await createUserWithEmailAndPassword(auth, 'existing@example.com', 'secret-pw-123');
    expect(createdPw.user.emailVerified).toBe(false);
    await signOut(auth);

    const jwt = makeUnsignedJwt({
      sub: 'google-federated-999',
      email: 'existing@example.com',
      name: 'Linked Name',
      picture: 'https://example.com/linked.png',
    });
    const signedIn = await signInWithCredential(auth, GoogleAuthProvider.credential(jwt));
    expect(signedIn.user.uid).toBe(createdPw.user.uid);
    expect(signedIn.user.emailVerified).toBe(false);
    expect(signedIn.user.displayName).toBe('Linked Name');
    expect(signedIn.user.photoURL).toBe('https://example.com/linked.png');
    expect(signedIn.user.providerData.map((p) => p.providerId)).toEqual(['password', 'google.com']);
    expect(getAdditionalUserInfo(signedIn)?.isNewUser).toBe(false);
  });

  it('supports generic OAuthProvider / oidc.* credentials and respects email_verified defaults per provider', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);

    const googleNoFlagJwt = makeUnsignedJwt({
      sub: 'google-default-verified',
      email: 'gdefault@example.com',
    });
    const gCred = await signInWithCredential(auth, GoogleAuthProvider.credential(googleNoFlagJwt));
    expect(gCred.user.emailVerified).toBe(true);

    const oidcNoFlagJwt = makeUnsignedJwt({
      sub: 'oidc-default-unverified',
      email: 'corp@example.com',
    });
    const oidcProvider = new OAuthProvider('oidc.corp');
    const oCred = await signInWithCredential(auth, oidcProvider.credential({ idToken: oidcNoFlagJwt }));
    expect(oCred.providerId).toBe('oidc.corp');
    expect(oCred.user.uid).toBe('oidc-default-unverified');
    expect(oCred.user.emailVerified).toBe(false);
  });

  it('enforces disabled provider, disabled account, tenant mismatch, and beforeAuthStateChanged gates', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const jwt = makeUnsignedJwt({
      sub: 'guarded-sub',
      email: 'guarded@example.com',
      email_verified: true,
    });

    authSandbox.setAuthProviderConfig(auth, 'google.com', false);
    expect(await catchCode(signInWithCredential(auth, GoogleAuthProvider.credential(jwt)))).toBe(
      'auth/operation-not-allowed',
    );
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);

    authSandbox.createUser(auth, {
      uid: 'guarded-sub',
      email: 'guarded@example.com',
      disabled: true,
      providerUserInfo: [{ providerId: 'google.com' }],
    });
    expect(await catchCode(signInWithCredential(auth, GoogleAuthProvider.credential(jwt)))).toBe(
      'auth/user-disabled',
    );
    expect(auth.currentUser).toBeNull();

    authSandbox.updateUser(auth, 'guarded-sub', { disabled: false });
    auth.tenantId = 'tenant-alpha';
    expect(await catchCode(signInWithCredential(auth, GoogleAuthProvider.credential(jwt)))).toBe(
      'auth/tenant-id-mismatch',
    );
    auth.tenantId = null;

    const unsubGate = beforeAuthStateChanged(auth, () => {
      throw new Error('blocked');
    });
    expect(await catchCode(signInWithCredential(auth, GoogleAuthProvider.credential(jwt)))).toBe(
      'auth/login-blocked',
    );
    expect(auth.currentUser).toBeNull();
    unsubGate();

    expect(resolveOidcJwtIdentity(auth, { providerId: 'password', idToken: jwt })).toBeNull();
  });
});
