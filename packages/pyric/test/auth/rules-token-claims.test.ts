/**
 * The token rules read for a signed-in session is the minted ID token's full
 * claim set, including the JWT registered claims `sub`, `aud`, `iss`, `iat`,
 * `exp` and `auth_time`, with the values the minter put in the token.
 *
 * Production evidence: Firebase's docs (firebase.google.com/docs/rules/rules-and-auth)
 * say "`sub`: The user's Firebase UID"; RTDB capture r42
 * (`rules-rtdb-r42-custom-token-standard-claims`) allows `sub == auth.uid`,
 * `iat`, `exp`, `iss`, `aud` and `auth_time` in deployed rules; the decoded
 * production token (`auth-id-token-standard-claims`) carries all six. The
 * auth-claims hunt (RA-1, AU-7) found `auth_time` refilled from the
 * evaluation or verify time, so a recent-login check never expires: production
 * keeps `auth_time` at the sign-in ("Each ID token will have a different iat
 * value, but the same auth_time value", firebase-admin `token-verifier.d.ts`).
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/database';
import { getDatabase, ref, set } from 'pyric/database';
import { doc, getFirestore, setDoc } from 'pyric/firestore';
import {
  EmailAuthProvider,
  getAuth,
  reauthenticateWithCredential,
  signInWithEmailAndPassword,
  signOut,
  sandbox as authSandbox,
} from '../../src/auth/index.js';
import { getStorageSandbox, ref as storageRef, uploadString } from '../../src/storage/index.js';
import { getClock } from '../../src/sandbox/internal/index.js';
import type { Sandbox } from '../../src/sandbox/index.js';

const STANDARD_CLAIMS = [
  'request.auth.token.sub == request.auth.uid',
  'request.auth.token.iss is string',
  'request.auth.token.aud is string',
  'request.auth.token.iat is int',
  'request.auth.token.auth_time is int',
  'request.auth.token.exp > request.auth.token.iat',
  'request.auth.token.auth_time <= request.auth.token.iat',
].join(' && ');

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /claims/{id} {
      allow write: if request.auth != null && ${STANDARD_CLAIMS};
    }
    match /open/{id} {
      allow write: if request.auth == null;
    }
  }
}`;

const STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /claims/{name} {
      allow write: if request.auth != null && ${STANDARD_CLAIMS};
    }
  }
}`;

const FIVE_MINUTES_MS = 5 * 60 * 1000;

const RTDB_RULES = {
  rules: {
    claims: { '.write': 'auth != null && auth.token.sub == auth.uid && auth.token.iss != null && auth.token.aud != null' },
    // A recent-login gate: production's auth_time is the sign-in, not now.
    recent: { '.write': `auth != null && auth.token.auth_time * 1000 > now - ${FIVE_MINUTES_MS}` },
  },
};

async function outcome(write: () => Promise<unknown>): Promise<'allowed' | 'denied'> {
  try {
    await write();
    return 'allowed';
  } catch {
    return 'denied';
  }
}

async function signedIn(): Promise<{ sandbox: Sandbox; uid: string }> {
  const sandbox = initializeSandbox();
  const auth = getAuth(sandbox);
  const record = authSandbox.createUser(auth, { email: 'ada@example.com', password: 'secret-pw' });
  await signInWithEmailAndPassword(auth, 'ada@example.com', 'secret-pw');
  return { sandbox, uid: record.uid };
}

async function setFirestoreRules(sandbox: Sandbox): Promise<void> {
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  getAdminFirestore(sandbox.withAuth(null)).setRules(FIRESTORE_RULES);
}

function storageFor(sandbox: Sandbox) {
  return getStorageSandbox(sandbox, {
    dbName: `pyric-rules-token-claims-${Math.random().toString(36).slice(2, 10)}`,
    rules: STORAGE_RULES,
  });
}

describe('rules read the JWT registered claims of a signed-in session', () => {
  it('Firestore allows sub == uid, iss, aud, iat, exp and auth_time', async () => {
    const { sandbox } = await signedIn();
    await setFirestoreRules(sandbox);
    expect(await outcome(() => setDoc(doc(getFirestore(sandbox), 'claims/a'), { ok: true }))).toBe('allowed');
  });

  it('Storage allows sub == uid, iss, aud, iat, exp and auth_time', async () => {
    const { sandbox } = await signedIn();
    const storage = storageFor(sandbox);
    expect(await outcome(() => uploadString(storageRef(storage, 'claims/a.txt'), 'x'))).toBe('allowed');
  });

  it('RTDB allows sub == uid, iss and aud', async () => {
    const { sandbox } = await signedIn();
    setRules(sandbox, RTDB_RULES);
    expect(await outcome(() => set(ref(getDatabase(sandbox), 'claims/v'), 1))).toBe('allowed');
  });

  it('the session token carries the minted values, unchanged', async () => {
    const { sandbox, uid } = await signedIn();
    const auth = getAuth(sandbox);
    const { claims } = await auth.currentUser!.getIdTokenResult();
    const token = sandbox.currentUser?.token ?? {};
    expect(token.sub).toBe(uid);
    for (const key of ['sub', 'aud', 'iss', 'iat', 'exp', 'auth_time']) expect(token[key]).toEqual(claims[key]);
  });

  it('a signed-out request still has no token', async () => {
    const { sandbox } = await signedIn();
    await signOut(getAuth(sandbox));
    await setFirestoreRules(sandbox);
    expect(sandbox.currentUser).toBeNull();
    expect(await outcome(() => setDoc(doc(getFirestore(sandbox), 'open/a'), { ok: true }))).toBe('allowed');
    expect(await outcome(() => setDoc(doc(getFirestore(sandbox), 'claims/a'), { ok: true }))).toBe('denied');
  });
});

describe('auth_time is the sign-in time, not the evaluation time (auth-claims RA-1)', () => {
  it('RTDB denies a recent-login rule once the sign-in is older than five minutes', async () => {
    const { sandbox } = await signedIn();
    setRules(sandbox, RTDB_RULES);
    const db = getDatabase(sandbox);
    expect(await outcome(() => set(ref(db, 'recent/v'), 1))).toBe('allowed');
    getClock(sandbox).advance(FIVE_MINUTES_MS + 60_000);
    expect(await outcome(() => set(ref(db, 'recent/v'), 2))).toBe('denied');
  });

  it('a forced refresh keeps auth_time and advances iat on the rules token', async () => {
    const { sandbox } = await signedIn();
    const auth = getAuth(sandbox);
    const before = { ...(sandbox.currentUser?.token ?? {}) };
    getClock(sandbox).advance(60_000);
    await auth.currentUser!.getIdToken(true);
    const after = sandbox.currentUser?.token ?? {};
    expect(after.auth_time).toBe(before.auth_time);
    expect(after.iat).toBe((before.iat as number) + 60);
  });

  it('reauthentication moves auth_time to the reauthentication', async () => {
    const { sandbox } = await signedIn();
    const auth = getAuth(sandbox);
    const signedInAt = sandbox.currentUser?.token?.auth_time as number;
    getClock(sandbox).advance(FIVE_MINUTES_MS + 60_000);
    await reauthenticateWithCredential(auth.currentUser!, EmailAuthProvider.credential('ada@example.com', 'secret-pw'));
    const token = sandbox.currentUser?.token ?? {};
    expect(token.auth_time).toBe(signedInAt + 360);
    expect(token.sub).toBe(auth.currentUser!.uid);
    setRules(sandbox, RTDB_RULES);
    expect(await outcome(() => set(ref(getDatabase(sandbox), 'recent/v'), 1))).toBe('allowed');
  });
});
