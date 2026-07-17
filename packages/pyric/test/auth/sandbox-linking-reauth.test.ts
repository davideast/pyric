/**
 * Account linking + re-authentication.
 *
 * The flow that matters most here is the ANONYMOUS UPGRADE: a user who has
 * been writing data as `anonymous-1` attaches an email credential and keeps
 * the same uid, so everything they created while anonymous is still theirs.
 * If the uid changed, the whole "let them try it, then let them keep it"
 * onboarding pattern would silently orphan the user's data — which is why the
 * uid assertions in this file are load-bearing rather than incidental.
 *
 * Evidence note: these behaviors are UNIT-BACKED, not oracle-backed. Probes
 * exist and were run, but the oracle project has the Email/Password provider
 * disabled, so they could not mint the credentials they needed. See the
 * NOT_APPLICABLE block in oracle-conformance.test.ts.
 */

import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  getAdditionalUserInfo,
  getAuth,
  GoogleAuthProvider,
  linkWithCredential,
  linkWithPopup,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  signInAnonymously,
  signInWithCredential,
  signInWithEmailAndPassword,
  signOut,
  unlink,
  sandbox as authSandbox,
  type Auth,
  type User,
} from '../../src/auth/index.js';

function freshAuth(): Auth {
  return getAuth(initializeSandbox());
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect((e as { code: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} to be thrown`);
}

function providerIds(user: User): string[] {
  return (user.providerData ?? []).map((p) => p.providerId);
}

describe('linkWithCredential — the anonymous upgrade', () => {
  it('keeps the uid, drops isAnonymous, and attaches the provider', async () => {
    const auth = freshAuth();
    const anon = await signInAnonymously(auth);
    const anonUid = anon.user.uid;
    expect(anon.user.isAnonymous).toBe(true);

    const cred = await linkWithCredential(
      auth.currentUser!,
      EmailAuthProvider.credential('ada@example.com', 'pw123456'),
    );

    // THE invariant: same uid. Everything the anonymous user wrote is still
    // addressable as theirs.
    expect(cred.user.uid).toBe(anonUid);
    expect(cred.user.isAnonymous).toBe(false);
    expect(cred.user.email).toBe('ada@example.com');
    expect(cred.operationType).toBe('link');
    expect(providerIds(cred.user)).toContain('password');
    // A link never creates an identity.
    expect(getAdditionalUserInfo(cred)!.isNewUser).toBe(false);
    // The upgraded identity is the live current user, same uid.
    expect(auth.currentUser!.uid).toBe(anonUid);
    expect(auth.currentUser!.isAnonymous).toBe(false);
  });

  it('the linked credential then works as a real sign-in', async () => {
    const auth = freshAuth();
    const anon = await signInAnonymously(auth);
    const uid = anon.user.uid;
    await linkWithCredential(auth.currentUser!, EmailAuthProvider.credential('ada@example.com', 'pw123456'));
    await signOut(auth);

    // The account really exists now, with a real password.
    const cred = await signInWithEmailAndPassword(auth, 'ada@example.com', 'pw123456');
    expect(cred.user.uid).toBe(uid);
  });

  it('rejects a provider the account already carries', async () => {
    const auth = freshAuth();
    await signInAnonymously(auth);
    await linkWithCredential(auth.currentUser!, EmailAuthProvider.credential('ada@example.com', 'pw123456'));
    await expectCode(
      linkWithCredential(auth.currentUser!, EmailAuthProvider.credential('other@example.com', 'pw123456')),
      'auth/provider-already-linked',
    );
  });

  it('rejects a credential another account already owns', async () => {
    const auth = freshAuth();
    await createUserWithEmailAndPassword(auth, 'owner@example.com', 'pw123456');
    await signOut(auth);

    await signInAnonymously(auth);
    // An address can back only one identity — granting the link would steal it.
    await expectCode(
      linkWithCredential(auth.currentUser!, EmailAuthProvider.credential('owner@example.com', 'pw123456')),
      'auth/email-already-in-use',
    );
  });

  it('links an OAuth provider through the resolver seam', async () => {
    const auth = freshAuth();
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);
    const anon = await signInAnonymously(auth);
    const uid = anon.user.uid;

    // The resolver is told this is a LINK, not a sign-in — so a host UI can
    // say "link your Google account" instead of "sign in".
    let sawAuthType: string | undefined;
    authSandbox.setAuthFlowResolver(auth, {
      openPopup: async (req) => {
        sawAuthType = req.authType;
        return { user: auth.currentUser!, providerId: 'google.com', operationType: 'link' };
      },
      openRedirect: async () => {
        throw new Error('unused');
      },
    });

    const cred = await linkWithPopup(auth.currentUser!, new GoogleAuthProvider());
    expect(sawAuthType).toBe('link');
    expect(cred.user.uid).toBe(uid);
    expect(cred.providerId).toBe('google.com');
    expect(cred.operationType).toBe('link');
    expect(providerIds(auth.currentUser!)).toContain('google.com');
  });

  it('throws argument-error when no resolver and no mock are wired', async () => {
    const auth = freshAuth();
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);
    await signInAnonymously(auth);
    await expectCode(linkWithPopup(auth.currentUser!, new GoogleAuthProvider()), 'auth/argument-error');
  });

  it('a disabled provider throws operation-not-allowed, ahead of the resolver check', async () => {
    const auth = freshAuth();
    await signInAnonymously(auth);
    authSandbox.setAuthProviderConfig(auth, 'google.com', false);
    // That code must stay distinct from the argument-error above, which
    // means "enabled, but nothing wired".
    await expectCode(linkWithPopup(auth.currentUser!, new GoogleAuthProvider()), 'auth/operation-not-allowed');
  });
});

describe('unlink', () => {
  it('detaches the provider and takes the password with it', async () => {
    const auth = freshAuth();
    await signInAnonymously(auth);
    await linkWithCredential(auth.currentUser!, EmailAuthProvider.credential('ada@example.com', 'pw123456'));
    expect(providerIds(auth.currentUser!)).toContain('password');

    const updated = await unlink(auth.currentUser!, 'password');
    expect(providerIds(updated)).not.toContain('password');
    // The observable point of unlinking it: the password no longer signs in.
    await signOut(auth);
    await expectCode(signInWithEmailAndPassword(auth, 'ada@example.com', 'pw123456'), 'auth/wrong-password');
  });

  it('throws no-such-provider for a provider that was never linked', async () => {
    const auth = freshAuth();
    await signInAnonymously(auth);
    await expectCode(unlink(auth.currentUser!, 'google.com'), 'auth/no-such-provider');
  });

  it('does not re-anonymize an account whose last provider was removed', async () => {
    const auth = freshAuth();
    await signInAnonymously(auth);
    await linkWithCredential(auth.currentUser!, EmailAuthProvider.credential('ada@example.com', 'pw123456'));
    const updated = await unlink(auth.currentUser!, 'password');
    // isAnonymous describes how an identity was BORN, not what it currently
    // carries. Prod agrees.
    expect(updated.isAnonymous).toBe(false);
  });
});

describe('reauthenticateWithCredential', () => {
  it('re-verifies the password and returns operationType reauthenticate', async () => {
    const auth = freshAuth();
    await createUserWithEmailAndPassword(auth, 'ada@example.com', 'pw123456');
    const user = auth.currentUser!;

    const cred = await reauthenticateWithCredential(
      user,
      EmailAuthProvider.credential('ada@example.com', 'pw123456'),
    );
    expect(cred.operationType).toBe('reauthenticate');
    expect(cred.user.uid).toBe(user.uid);
  });

  it('mints a fresh token — the observable trace of the re-verification', async () => {
    const auth = freshAuth();
    await createUserWithEmailAndPassword(auth, 'ada@example.com', 'pw123456');
    const user = auth.currentUser!;
    const before = await user.getIdToken();

    await reauthenticateWithCredential(user, EmailAuthProvider.credential('ada@example.com', 'pw123456'));

    const after = await user.getIdToken();
    expect(after).not.toBe(before);
  });

  it('throws wrong-password for a bad password', async () => {
    const auth = freshAuth();
    await createUserWithEmailAndPassword(auth, 'ada@example.com', 'pw123456');
    await expectCode(
      reauthenticateWithCredential(auth.currentUser!, EmailAuthProvider.credential('ada@example.com', 'nope999')),
      'auth/wrong-password',
    );
  });

  it('throws user-mismatch for another account’s credential', async () => {
    const auth = freshAuth();
    await createUserWithEmailAndPassword(auth, 'other@example.com', 'pw123456');
    await signOut(auth);
    await createUserWithEmailAndPassword(auth, 'ada@example.com', 'pw123456');

    // The check that stops "reauthenticate as someone else" from succeeding.
    // Fires BEFORE the password compare, so it cannot leak whether the other
    // account's password was right.
    await expectCode(
      reauthenticateWithCredential(auth.currentUser!, EmailAuthProvider.credential('other@example.com', 'pw123456')),
      'auth/user-mismatch',
    );
  });

  it('popup reauth rejects a resolver that hands back a DIFFERENT user', async () => {
    const auth = freshAuth();
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);
    await createUserWithEmailAndPassword(auth, 'ada@example.com', 'pw123456');
    const me = auth.currentUser!;

    const impostor = authSandbox.createSignInCredential(auth, {
      providerId: 'google.com',
      spec: { email: 'eve@example.com' },
    });
    authSandbox.setAuthFlowResolver(auth, {
      openPopup: async () => impostor,
      openRedirect: async () => impostor,
    });

    // The entire security content of the flow: the identity the resolver
    // produced must BE the user being re-authenticated.
    await expectCode(reauthenticateWithPopup(me, new GoogleAuthProvider()), 'auth/user-mismatch');
  });

  it('popup reauth accepts the same user and reports authType reauth', async () => {
    const auth = freshAuth();
    authSandbox.setAuthProviderConfig(auth, 'google.com', true);
    await createUserWithEmailAndPassword(auth, 'ada@example.com', 'pw123456');
    const me = auth.currentUser!;

    let sawAuthType: string | undefined;
    authSandbox.setAuthFlowResolver(auth, {
      openPopup: async (req) => {
        sawAuthType = req.authType;
        return { user: me, providerId: 'google.com', operationType: 'reauthenticate' };
      },
      openRedirect: async () => {
        throw new Error('unused');
      },
    });

    const cred = await reauthenticateWithPopup(me, new GoogleAuthProvider());
    expect(sawAuthType).toBe('reauth');
    expect(cred.operationType).toBe('reauthenticate');
    expect(cred.user.uid).toBe(me.uid);
  });
});

describe('signInWithCredential with a real email credential', () => {
  it('signs in without any mock or resolver — the credential carries the secret', async () => {
    const auth = freshAuth();
    await createUserWithEmailAndPassword(auth, 'ada@example.com', 'pw123456');
    const uid = auth.currentUser!.uid;
    await signOut(auth);

    // Previously this threw `auth/no-mock-configured` — a sandbox-only error
    // for a call production handles fine.
    const cred = await signInWithCredential(auth, EmailAuthProvider.credential('ada@example.com', 'pw123456'));
    expect(cred.user.uid).toBe(uid);
    expect(cred.operationType).toBe('signIn');
    expect(cred.providerId).toBeNull();
  });

  it('rejects a wrong password', async () => {
    const auth = freshAuth();
    await createUserWithEmailAndPassword(auth, 'ada@example.com', 'pw123456');
    await signOut(auth);
    await expectCode(
      signInWithCredential(auth, EmailAuthProvider.credential('ada@example.com', 'wrong999')),
      'auth/wrong-password',
    );
  });
});

describe('credential classes', () => {
  it('keeps the secret off enumeration, but toJSON still carries it (upstream parity)', () => {
    const cred = EmailAuthProvider.credential('ada@example.com', 'sup3r-s3cret');
    // The backing field is non-enumerable, so a spread or an Object.keys walk
    // in host code does not pick the password up.
    expect(Object.keys(cred)).not.toContain('secret');
    expect(JSON.stringify({ ...cred })).not.toContain('sup3r-s3cret');

    // But `toJSON()` DOES carry it — and so, therefore, does
    // `JSON.stringify(cred)`, which calls it. That is upstream's behavior
    // (EmailAuthCredential.toJSON emits `password`, and `fromJSON` needs it
    // to round-trip), and fidelity to upstream wins over a protection the
    // real SDK does not offer. Pinned here so nobody "hardens" it into a
    // divergence later.
    expect(cred.toJSON().password).toBe('sup3r-s3cret');
    expect(JSON.stringify(cred)).toContain('sup3r-s3cret');

    expect(cred.password).toBe('sup3r-s3cret');
    expect(cred.emailLink).toBeNull();
  });

  it('an email-LINK credential carries the link, not a password', () => {
    const cred = EmailAuthProvider.credentialWithLink('ada@example.com', 'https://x.test/f?mode=signIn&oobCode=C');
    expect(cred.signInMethod).toBe('emailLink');
    expect(cred.password).toBeNull();
    expect(cred.emailLink).toContain('oobCode=C');
  });
});
