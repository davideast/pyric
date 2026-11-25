import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { createAppForSandbox } from 'pyric/app/internal';
import {
  applyFullState,
  captureFullState,
  createMemoryBackend,
  initializeSandbox,
  SandboxError,
} from 'pyric/sandbox';
import { authAccountsFor } from 'pyric/sandbox/internal';
import {
  confirmPasswordReset,
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  getAuth,
  reauthenticateWithCredential,
  sandbox as authSandbox,
  sendPasswordResetEmail,
  signInWithCredential,
  signInWithEmailAndPassword,
  signOut,
  updateEmail,
} from 'pyric/auth';
import { setAuthBlockingHooks } from 'pyric/auth/internal';

async function expectAuthError(
  promise: Promise<unknown>,
  expectedCode: string,
): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (err) {
    const typed = err as { code: string; message: string };
    expect(typed.code).toBe(expectedCode);
    return typed;
  }
  throw new Error(`Expected ${expectedCode} to be thrown`);
}

describe('Auth emailEnumerationProtection project setting (#1689)', () => {
  it('defaults to true and shares project setting across multiple apps and authAccountsFor(sandbox)', () => {
    const sandbox = initializeSandbox();
    const appA = createAppForSandbox(sandbox, { projectId: 'demo-eep', apiKey: 'key-a' }, 'eep-a');
    const appB = createAppForSandbox(sandbox, { projectId: 'demo-eep', apiKey: 'key-b' }, 'eep-b');
    const authA = getAuth(appA);
    const authB = getAuth(appB);

    expect(authSandbox.getEmailEnumerationProtection(authA)).toBe(true);
    expect(authSandbox.getEmailEnumerationProtection(authB)).toBe(true);
    expect(authAccountsFor(sandbox)?.emailEnumerationProtection()).toBe(true);

    let notifications = 0;
    const unsub = authSandbox.subscribeEmailEnumerationProtection(authB, () => {
      notifications += 1;
    });

    authSandbox.setEmailEnumerationProtection(authA, false);
    expect(authSandbox.getEmailEnumerationProtection(authA)).toBe(false);
    expect(authSandbox.getEmailEnumerationProtection(authB)).toBe(false);
    expect(authAccountsFor(sandbox)?.emailEnumerationProtection()).toBe(false);
    expect(notifications).toBe(1);

    // Idempotent duplicate write does not fire subscribers again.
    authSandbox.setEmailEnumerationProtection(authA, false);
    expect(notifications).toBe(1);

    authAccountsFor(sandbox)?.setEmailEnumerationProtection(true);
    expect(authSandbox.getEmailEnumerationProtection(authA)).toBe(true);
    expect(notifications).toBe(2);

    unsub();
    authSandbox.setEmailEnumerationProtection(authA, false);
    expect(notifications).toBe(2);
    sandbox.dispose();
  });

  it('rejects non-boolean input with SandboxError(invalid-argument)', () => {
    const auth = getAuth(initializeSandbox());
    expect(() => authSandbox.setEmailEnumerationProtection(auth, 'false' as unknown as boolean)).toThrow(SandboxError);
  });

  it('switches signInWithEmailAndPassword, signInWithCredential, and reauthenticateWithCredential error codes cleanly', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    await createUserWithEmailAndPassword(auth, 'alice@example.com', 'correct-pw-123');
    await createUserWithEmailAndPassword(auth, 'bob@example.com', 'correct-pw-123');
    await signOut(auth);

    // Default (protection on): both unknown email and wrong password return auth/invalid-credential.
    await expectAuthError(
      signInWithEmailAndPassword(auth, 'nobody@example.com', 'correct-pw-123'),
      'auth/invalid-credential',
    );
    await expectAuthError(
      signInWithEmailAndPassword(auth, 'alice@example.com', 'wrong-pw-999'),
      'auth/invalid-credential',
    );
    await expectAuthError(
      signInWithCredential(auth, EmailAuthProvider.credential('nobody@example.com', 'correct-pw-123')),
      'auth/invalid-credential',
    );
    await expectAuthError(
      signInWithCredential(auth, EmailAuthProvider.credential('alice@example.com', 'wrong-pw-999')),
      'auth/invalid-credential',
    );

    // Protection off: unknown email -> auth/user-not-found, wrong password -> auth/wrong-password.
    authSandbox.setEmailEnumerationProtection(auth, false);
    const notFoundErr = await expectAuthError(
      signInWithEmailAndPassword(auth, 'nobody@example.com', 'correct-pw-123'),
      'auth/user-not-found',
    );
    expect(notFoundErr.message).toBe('Firebase: Error (auth/user-not-found).');

    const wrongPwErr = await expectAuthError(
      signInWithEmailAndPassword(auth, 'alice@example.com', 'wrong-pw-999'),
      'auth/wrong-password',
    );
    expect(wrongPwErr.message).toBe('Firebase: Error (auth/wrong-password).');

    await expectAuthError(
      signInWithCredential(auth, EmailAuthProvider.credential('nobody@example.com', 'correct-pw-123')),
      'auth/user-not-found',
    );
    await expectAuthError(
      signInWithCredential(auth, EmailAuthProvider.credential('alice@example.com', 'wrong-pw-999')),
      'auth/wrong-password',
    );

    // Format and empty-password checks still precede account lookup.
    await expectAuthError(signInWithEmailAndPassword(auth, 'bad-email', ''), 'auth/invalid-email');
    await expectAuthError(signInWithEmailAndPassword(auth, 'nobody@example.com', ''), 'auth/missing-password');

    // Reauthentication: user-mismatch still wins for a different user; wrong password for the same user follows setting.
    const signedIn = await signInWithEmailAndPassword(auth, 'alice@example.com', 'correct-pw-123');
    await expectAuthError(
      reauthenticateWithCredential(signedIn.user, EmailAuthProvider.credential('bob@example.com', 'wrong-pw-999')),
      'auth/user-mismatch',
    );
    await expectAuthError(
      reauthenticateWithCredential(signedIn.user, EmailAuthProvider.credential('alice@example.com', 'wrong-pw-999')),
      'auth/wrong-password',
    );
    authSandbox.setEmailEnumerationProtection(auth, true);
    await expectAuthError(
      reauthenticateWithCredential(signedIn.user, EmailAuthProvider.credential('alice@example.com', 'wrong-pw-999')),
      'auth/invalid-credential',
    );
    sandbox.dispose();
  });

  it('honors emailEnumerationProtection when beforeSignIn blocking hooks are active and isolates tenants', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.seedUsers(auth, [
      { uid: 'tenant-a-u1', email: 'shared@example.com', password: 'secret-password', tenantId: 'tenant-a' },
    ]);
    let hookCalls = 0;
    setAuthBlockingHooks(auth, {
      beforeSignIn: async () => {
        hookCalls += 1;
        return {};
      },
    });

    authSandbox.setEmailEnumerationProtection(auth, false);
    auth.tenantId = 'tenant-b';
    await expectAuthError(
      signInWithEmailAndPassword(auth, 'shared@example.com', 'secret-password'),
      'auth/user-not-found',
    );
    auth.tenantId = 'tenant-a';
    await expectAuthError(
      signInWithEmailAndPassword(auth, 'shared@example.com', 'wrong-password'),
      'auth/wrong-password',
    );
    expect(hookCalls).toBe(0);

    await signInWithEmailAndPassword(auth, 'shared@example.com', 'secret-password');
    expect(hookCalls).toBe(1);
    sandbox.dispose();
  });

  it('governs sendPasswordResetEmail for unknown emails while keeping known-account resets and updateEmail intact', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const created = await createUserWithEmailAndPassword(auth, 'reset@example.com', 'initial-pw-123');

    // Default (protection on): unknown email resolves silently with empty outbox.
    await expect(sendPasswordResetEmail(auth, 'missing@example.com')).resolves.toBeUndefined();
    expect(authSandbox.listAuthMail(auth)).toEqual([]);

    // Protection off: unknown email throws auth/user-not-found; malformed email still throws auth/invalid-email.
    authSandbox.setEmailEnumerationProtection(auth, false);
    await expectAuthError(sendPasswordResetEmail(auth, 'bad-email'), 'auth/invalid-email');
    await expectAuthError(sendPasswordResetEmail(auth, 'missing@example.com'), 'auth/user-not-found');
    expect(authSandbox.listAuthMail(auth)).toEqual([]);

    // Known account still receives reset mail and completes confirmPasswordReset.
    await sendPasswordResetEmail(auth, 'reset@example.com');
    const mail = authSandbox.takeAuthMail(auth, 'reset@example.com');
    expect(mail).not.toBeNull();
    if (mail === null) {
      throw new Error('Expected password reset mail');
    }
    await confirmPasswordReset(auth, mail.code, 'updated-pw-456');
    await expectAuthError(
      signInWithEmailAndPassword(auth, 'reset@example.com', 'initial-pw-123'),
      'auth/wrong-password',
    );

    // updateEmail stays available on fresh sessions (auth#84).
    const freshCred = await signInWithEmailAndPassword(auth, 'reset@example.com', 'updated-pw-456');
    await updateEmail(freshCred.user, 'renamed@example.com');
    expect(freshCred.user.email).toBe('renamed@example.com');
    void created;
    sandbox.dispose();
  });

  it('round-trips emailEnumerationProtection across persistence, captureFullState/applyFullState, and reset', async () => {
    const backend = createMemoryBackend();
    const s1 = initializeSandbox();
    await s1.enablePersistence({ backend });
    const auth1 = getAuth(s1);
    // Default true omits emailEnumerationProtection from history snapshot.
    expect(authAccountsFor(s1)?.history()).toEqual({
      tokensValidAfterMs: {},
      deletedUids: [],
    });

    authSandbox.setEmailEnumerationProtection(auth1, false);
    expect(authAccountsFor(s1)?.history()).toEqual({
      tokensValidAfterMs: {},
      deletedUids: [],
      emailEnumerationProtection: false,
    });
    await s1.flush();

    const capturedDisabled = await captureFullState(s1);
    s1.dispose();

    // Persistence reload restores emailEnumerationProtection = false.
    const s2 = initializeSandbox();
    await s2.enablePersistence({ backend });
    const auth2 = getAuth(s2);
    expect(authSandbox.getEmailEnumerationProtection(auth2)).toBe(false);
    await expectAuthError(
      signInWithEmailAndPassword(auth2, 'nobody@example.com', 'pw123456'),
      'auth/user-not-found',
    );

    // resetAll() restores default emailEnumerationProtection = true.
    await s2.resetAll();
    expect(authSandbox.getEmailEnumerationProtection(auth2)).toBe(true);
    await expectAuthError(
      signInWithEmailAndPassword(auth2, 'nobody@example.com', 'pw123456'),
      'auth/invalid-credential',
    );

    // applyFullState restores captured false setting and resets when applying a default state.
    const defaultSandbox = initializeSandbox();
    getAuth(defaultSandbox);
    const capturedDefault = await captureFullState(defaultSandbox);

    await applyFullState(s2, capturedDisabled);
    expect(authSandbox.getEmailEnumerationProtection(auth2)).toBe(false);
    await applyFullState(s2, capturedDefault);
    expect(authSandbox.getEmailEnumerationProtection(auth2)).toBe(true);

    defaultSandbox.dispose();
    s2.dispose();
  });
});
