/**
 * The token rules see after a sign-in: the custom claims plus the `firebase`
 * namespace the minted ID token carries, so `auth.provider`,
 * `auth.token.firebase.sign_in_provider`, and
 * `request.auth.token.firebase.sign_in_provider` read in the sandbox as they
 * do in production (captures rules-rtdb-r12 and rules-rtdb-r16).
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/database';
import { getDatabase, ref, set } from 'pyric/database';
import { doc, getFirestore, setDoc } from 'pyric/firestore';
import { getAuth, signInAnonymously, sandbox as authSandbox } from '../../src/auth/index.js';

const RTDB_RULES = {
  rules: {
    provider: { '.write': "auth.provider == 'anonymous'" },
    claim: { '.write': "auth.token.firebase.sign_in_provider == 'anonymous'" },
  },
};

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /anon/{id} {
      allow write: if request.auth.token.firebase.sign_in_provider == 'anonymous';
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

describe('rules see the sign-in provider after a sign-in', () => {
  it('RTDB reads auth.provider and the firebase claim for an anonymous user', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, RTDB_RULES);
    await signInAnonymously(getAuth(sandbox));
    const db = getDatabase(sandbox);
    expect(await outcome(() => set(ref(db, 'provider/v'), 1))).toBe('allowed');
    expect(await outcome(() => set(ref(db, 'claim/v'), 1))).toBe('allowed');
  });

  it('Firestore reads request.auth.token.firebase.sign_in_provider for an anonymous user', async () => {
    const sandbox = initializeSandbox();
    const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
    getAdminFirestore(sandbox.withAuth(null)).setRules(FIRESTORE_RULES);
    await signInAnonymously(getAuth(sandbox));
    expect(await outcome(() => setDoc(doc(getFirestore(sandbox), 'anon/a'), { ok: true }))).toBe('allowed');
  });

  it('a forced token refresh keeps the claim rules read', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, RTDB_RULES);
    const { user } = await signInAnonymously(getAuth(sandbox));
    await user.getIdTokenResult(true);
    expect(await outcome(() => set(ref(getDatabase(sandbox), 'provider/v'), 1))).toBe('allowed');
  });

  it('a per-connection session carries the same claims', () => {
    const auth = getAuth(initializeSandbox());
    const { state } = authSandbox.mintSession(auth, { kind: 'anonymous' });
    const firebase = (state?.token as { firebase?: { sign_in_provider?: string } } | undefined)?.firebase;
    expect(firebase?.sign_in_provider).toBe('anonymous');
  });
});
