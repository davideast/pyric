/**
 * ID token lifetime on the in-page plane (#1836): a minted token lasts one
 * hour, as production's does (auth#68c: `exp - iat` is 3600), and a cached
 * token past its refresh point is minted again on read. The refresh point is
 * `exp * 1000 - 30000` on the sandbox clock, `TOKEN_REFRESH_BUFFER_MS` in
 * `@firebase/auth` 1.13.6 (`StsTokenManager.isExpired`).
 *
 * The worker plane's twin is `packages/cli/test/serve/worker/auth-token-lifetime.test.ts`.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { checkIdToken, getClock } from 'pyric/sandbox/internal';
import { doc, getFirestore, setDoc } from 'pyric/firestore';
import {
  getAuth,
  onAuthStateChanged,
  onIdTokenChanged,
  sandbox as authSandbox,
  signInWithEmailAndPassword,
  type User,
} from '../../src/auth/index.js';
import type { Sandbox } from '../../src/sandbox/index.js';

const HOUR_MS = 60 * 60 * 1000;
const REFRESH_BUFFER_MS = 30_000;

/** A rule that holds only while the session's token is unexpired at request time. */
const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /fresh/{id} {
      allow write: if request.auth != null && request.auth.token.exp * 1000 > request.time.toMillis();
    }
  }
}`;

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

async function signedIn(): Promise<{ sandbox: Sandbox; user: User }> {
  const sandbox = initializeSandbox();
  getClock(sandbox).set(Date.UTC(2026, 0, 1));
  const auth = getAuth(sandbox);
  authSandbox.createUser(auth, { email: 'ada@example.com', password: 'secret-pw' });
  const { user } = await signInWithEmailAndPassword(auth, 'ada@example.com', 'secret-pw');
  return { sandbox, user };
}

async function decodedClaims(token: string): Promise<Record<string, unknown>> {
  const check = await checkIdToken(token);
  if (!check.ok) throw new Error(`token did not check: ${check.reason}`);
  return check.claims;
}

describe('ID tokens last one hour', () => {
  it('a minted token has exp - iat of 3600, in the token and the IdTokenResult', async () => {
    const { user } = await signedIn();
    const result = await user.getIdTokenResult();
    const claims = await decodedClaims(result.token);
    expect((claims.exp as number) - (claims.iat as number)).toBe(3600);
    expect(Date.parse(result.expirationTime) - Date.parse(result.issuedAtTime)).toBe(HOUR_MS);
  });
});

describe('getIdToken() past the refresh point returns a fresh token', () => {
  it('keeps the cached token up to exp - 30 s and mints a new one after it', async () => {
    const { sandbox, user } = await signedIn();
    const first = await user.getIdToken();
    const { exp } = await decodedClaims(first);
    const clock = getClock(sandbox);

    clock.set((exp as number) * 1000 - REFRESH_BUFFER_MS);
    expect(await user.getIdToken()).toBe(first);

    clock.advance(1);
    const second = await user.getIdToken();
    expect(second).not.toBe(first);
    const claims = await decodedClaims(second);
    expect(claims.iat).toBe(Math.floor(clock.now() / 1000));
    expect((claims.exp as number) - (claims.iat as number)).toBe(3600);
    expect(await user.getIdToken()).toBe(second);
  });

  it('after the clock moves 61 minutes, getIdTokenResult() reports the new lifetime', async () => {
    const { sandbox, user } = await signedIn();
    const before = await user.getIdTokenResult();
    getClock(sandbox).advance(61 * 60 * 1000);
    const after = await user.getIdTokenResult();
    expect(after.token).not.toBe(before.token);
    expect(Date.parse(after.issuedAtTime)).toBe(getClock(sandbox).now());
    expect(after.authTime).toBe(before.authTime);
  });

  it('the re-mint fires onIdTokenChanged and not onAuthStateChanged', async () => {
    const { sandbox, user } = await signedIn();
    const auth = getAuth(sandbox);
    await user.getIdToken();
    const idTokenFires: Array<string | null> = [];
    const authStateFires: Array<string | null> = [];
    onIdTokenChanged(auth, (u) => { idTokenFires.push(u?.uid ?? null); });
    onAuthStateChanged(auth, (u) => { authStateFires.push(u?.uid ?? null); });
    await flush();

    getClock(sandbox).advance(61 * 60 * 1000);
    await user.getIdToken();
    await flush();
    expect(idTokenFires).toEqual([user.uid, user.uid]);
    expect(authStateFires).toEqual([user.uid]);
  });

  it('rules read the re-minted token', async () => {
    const { sandbox, user } = await signedIn();
    const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
    getAdminFirestore(sandbox.withAuth(null)).setRules(FIRESTORE_RULES);
    const db = getFirestore(sandbox);
    await setDoc(doc(db, 'fresh/a'), { ok: true });

    getClock(sandbox).advance(61 * 60 * 1000);
    await user.getIdToken();
    await setDoc(doc(db, 'fresh/b'), { ok: true });
  });
});
