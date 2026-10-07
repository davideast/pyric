/**
 * The standard claims a signed-in session carries on its ID token and on the
 * `auth.token` the rules engines read: `email`, `email_verified`, `name`,
 * `picture`, `phone_number`, `user_id`, and `firebase.identities` keyed by
 * identity type. Expected shapes come from decoded production ID tokens
 * (capture auth-id-token-standard-claims).
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/database';
import { getDatabase, ref, set } from 'pyric/database';
import { doc, getFirestore, setDoc } from 'pyric/firestore';
import {
  getAuth,
  signInAnonymously,
  signInWithEmailAndPassword,
  sandbox as authSandbox,
} from '../../src/auth/index.js';
import { getStorageSandbox, ref as storageRef, uploadString } from '../../src/storage/index.js';
import type { Sandbox } from '../../src/sandbox/index.js';

const RTDB_RULES = {
  rules: {
    verified: { '.write': 'auth.token.email_verified == true' },
    domain: { '.write': "auth.token.email.matches(/.*@example[.]com$/)" },
    identity: { '.write': 'auth.token.firebase.identities.email[0] == auth.token.email' },
  },
};

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /verified/{id} {
      allow write: if request.auth.token.email_verified == true;
    }
  }
}`;

const STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /verified/{name} {
      allow write: if request.auth.token.email_verified == true;
    }
  }
}`;

async function outcome(write: () => Promise<unknown>): Promise<'allowed' | 'denied'> {
  try {
    await write();
    return 'allowed';
  } catch {
    return 'denied';
  }
}

async function signInPasswordUser(emailVerified: boolean): Promise<{ sandbox: Sandbox; uid: string }> {
  const sandbox = initializeSandbox();
  const auth = getAuth(sandbox);
  const record = authSandbox.createUser(auth, {
    email: 'ada@example.com',
    password: 'secret-pw',
    emailVerified,
  });
  await signInWithEmailAndPassword(auth, 'ada@example.com', 'secret-pw');
  return { sandbox, uid: record.uid };
}

describe('rules read the standard token claims of a password user', () => {
  for (const verified of [true, false]) {
    const expected = verified ? 'allowed' : 'denied';

    it(`RTDB auth.token.email_verified: ${verified ? 'verified allowed' : 'unverified denied'}`, async () => {
      const { sandbox } = await signInPasswordUser(verified);
      setRules(sandbox, RTDB_RULES);
      const db = getDatabase(sandbox);
      expect(await outcome(() => set(ref(db, 'verified/v'), 1))).toBe(expected);
      expect(await outcome(() => set(ref(db, 'domain/v'), 1))).toBe('allowed');
      expect(await outcome(() => set(ref(db, 'identity/v'), 1))).toBe('allowed');
    });

    it(`Firestore request.auth.token.email_verified: ${verified ? 'verified allowed' : 'unverified denied'}`, async () => {
      const { sandbox } = await signInPasswordUser(verified);
      const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
      getAdminFirestore(sandbox.withAuth(null)).setRules(FIRESTORE_RULES);
      expect(await outcome(() => setDoc(doc(getFirestore(sandbox), 'verified/a'), { ok: true }))).toBe(expected);
    });

    it(`Storage request.auth.token.email_verified: ${verified ? 'verified allowed' : 'unverified denied'}`, async () => {
      const { sandbox } = await signInPasswordUser(verified);
      const storage = getStorageSandbox(sandbox, {
        dbName: `pyric-standard-claims-${Math.random().toString(36).slice(2, 10)}`,
        rules: STORAGE_RULES,
      });
      expect(await outcome(() => uploadString(storageRef(storage, 'verified/a.txt'), 'x'))).toBe(expected);
    });
  }
});

describe('getIdTokenResult().claims matches the production claim shape', () => {
  it('an unverified password user carries email, email_verified, user_id and the email identity', async () => {
    const { sandbox, uid } = await signInPasswordUser(false);
    const { claims } = await getAuth(sandbox).currentUser!.getIdTokenResult();
    expect(claims.email).toBe('ada@example.com');
    expect(claims.email_verified).toBe(false);
    expect(claims.user_id).toBe(uid);
    expect(claims.firebase).toEqual({ identities: { email: ['ada@example.com'] }, sign_in_provider: 'password' });
    expect('name' in claims).toBe(false);
    expect('picture' in claims).toBe(false);
    expect('phone_number' in claims).toBe(false);
  });

  it('profile fields and a phone number add name, picture, phone_number and the phone identity', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.createUser(auth, {
      email: 'ada@example.com',
      password: 'secret-pw',
      emailVerified: true,
      displayName: 'Ada',
      photoUrl: 'https://example.com/ada.png',
      phoneNumber: '+16505550100',
    });
    await signInWithEmailAndPassword(auth, 'ada@example.com', 'secret-pw');
    const { claims } = await auth.currentUser!.getIdTokenResult();
    expect(claims.email_verified).toBe(true);
    expect(claims.name).toBe('Ada');
    expect(claims.picture).toBe('https://example.com/ada.png');
    expect(claims.phone_number).toBe('+16505550100');
    expect(claims.firebase).toEqual({
      identities: { email: ['ada@example.com'], phone: ['+16505550100'] },
      sign_in_provider: 'password',
    });
  });

  it('an anonymous user carries provider_id and empty identities, and no email claims', async () => {
    const auth = getAuth(initializeSandbox());
    const { user } = await signInAnonymously(auth);
    const { claims } = await user.getIdTokenResult();
    expect(claims.provider_id).toBe('anonymous');
    expect(claims.user_id).toBe(user.uid);
    expect(claims.firebase).toEqual({ identities: {}, sign_in_provider: 'anonymous' });
    expect('email' in claims).toBe(false);
    expect('email_verified' in claims).toBe(false);
  });

  it('account values win over custom claims of the same name; a custom claim stays when the account has no value', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.createUser(auth, {
      email: 'ada@example.com',
      password: 'secret-pw',
      customClaims: { email_verified: true, email: 'custom@example.com', name: 'custom-name' },
    });
    await signInWithEmailAndPassword(auth, 'ada@example.com', 'secret-pw');
    const { claims } = await auth.currentUser!.getIdTokenResult();
    expect(claims.email).toBe('ada@example.com');
    expect(claims.email_verified).toBe(false);
    expect(claims.name).toBe('custom-name');
  });

  it('a verification recorded after sign-in reaches rules on the next forced refresh', async () => {
    const { sandbox, uid } = await signInPasswordUser(false);
    setRules(sandbox, RTDB_RULES);
    const auth = getAuth(sandbox);
    const db = getDatabase(sandbox);
    expect(await outcome(() => set(ref(db, 'verified/v'), 1))).toBe('denied');
    authSandbox.updateUser(auth, uid, { emailVerified: true });
    await auth.currentUser!.getIdTokenResult(true);
    expect(await outcome(() => set(ref(db, 'verified/v'), 1))).toBe('allowed');
  });

  it('a per-connection session carries the standard claims to rules', () => {
    const auth = getAuth(initializeSandbox());
    authSandbox.createUser(auth, { email: 'ada@example.com', password: 'secret-pw', emailVerified: true });
    const { state } = authSandbox.mintSession(auth, { kind: 'password', email: 'ada@example.com', password: 'secret-pw' });
    expect(state?.token?.email).toBe('ada@example.com');
    expect(state?.token?.email_verified).toBe(true);
    expect(state?.token?.firebase).toEqual({ identities: { email: ['ada@example.com'] }, sign_in_provider: 'password' });
  });
});
