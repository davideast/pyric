/**
 * Email-link / action-code family — the sandbox's model of the flows that
 * production cannot complete without a human.
 *
 * The load-bearing test in this file is "the round trip closes": a code the
 * sandbox MAILED is a code the sandbox REDEEMS, and redeeming it produces the
 * real state change. If that holds, the outbox is not a mock — it is the
 * inbox, minus the human.
 */

import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  ActionCodeOperation,
  ActionCodeURL,
  applyActionCode,
  checkActionCode,
  confirmPasswordReset,
  createUserWithEmailAndPassword,
  getAdditionalUserInfo,
  getAuth,
  isSignInWithEmailLink,
  parseActionCodeURL,
  sendEmailVerification,
  sendPasswordResetEmail,
  sendSignInLinkToEmail,
  signInWithEmailAndPassword,
  signInWithEmailLink,
  signOut,
  verifyBeforeUpdateEmail,
  verifyPasswordResetCode,
  sandbox as authSandbox,
  type Auth,
} from '../../src/auth/index.js';

const SETTINGS = { url: 'https://app.example.com/finish', handleCodeInApp: true };

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

describe('ActionCodeURL / parseActionCodeURL', () => {
  it('parses a well-formed link and normalizes mode -> operation', () => {
    const url = ActionCodeURL.parseLink(
      'https://x.test/f?mode=verifyEmail&oobCode=C1&apiKey=K&continueUrl=https%3A%2F%2Fapp.test%2Fnext&lang=es',
    );
    expect(url).not.toBeNull();
    expect(url!.operation).toBe(ActionCodeOperation.VERIFY_EMAIL);
    expect(url!.code).toBe('C1');
    expect(url!.apiKey).toBe('K');
    expect(url!.continueUrl).toBe('https://app.test/next');
    expect(url!.languageCode).toBe('es');
  });

  it('returns null (never throws) for links it cannot use', () => {
    expect(parseActionCodeURL('https://x.test/f?oobCode=C&apiKey=K')).toBeNull(); // no mode
    expect(parseActionCodeURL('https://x.test/f?mode=signIn&apiKey=K')).toBeNull(); // no code
    expect(parseActionCodeURL('https://x.test/f?mode=nonsense&oobCode=C')).toBeNull(); // unknown mode
    expect(parseActionCodeURL('not a url')).toBeNull();
    expect(parseActionCodeURL('')).toBeNull();
  });
});

describe('sendSignInLinkToEmail — settings validation', () => {
  it('requires a continue url', async () => {
    const auth = freshAuth();
    await expectCode(
      sendSignInLinkToEmail(auth, 'a@b.test', { handleCodeInApp: true } as never),
      'auth/invalid-continue-uri',
    );
    await expectCode(
      sendSignInLinkToEmail(auth, 'a@b.test', { url: 'not-a-url', handleCodeInApp: true }),
      'auth/invalid-continue-uri',
    );
  });

  it('requires handleCodeInApp: true', async () => {
    const auth = freshAuth();
    await expectCode(
      sendSignInLinkToEmail(auth, 'a@b.test', { url: 'https://app.test/f', handleCodeInApp: false }),
      'auth/argument-error',
    );
  });
});

describe('email-link sign-in — the round trip', () => {
  it('mails a link whose code actually signs the user in, and creates the account', async () => {
    const auth = freshAuth();
    await sendSignInLinkToEmail(auth, 'ada@example.com', SETTINGS);

    // The "inbox".
    const mail = authSandbox.takeAuthMail(auth);
    expect(mail).not.toBeNull();
    expect(mail!.email).toBe('ada@example.com');
    expect(mail!.operation).toBe(ActionCodeOperation.EMAIL_SIGNIN);

    // The mailed link is a REAL link: it round-trips through the same public
    // predicate and parser an app would use on `location.href`.
    expect(isSignInWithEmailLink(auth, mail!.link)).toBe(true);
    expect(parseActionCodeURL(mail!.link)!.code).toBe(mail!.code);

    const cred = await signInWithEmailLink(auth, 'ada@example.com', mail!.link);
    expect(auth.currentUser?.uid).toBe(cred.user.uid);
    expect(cred.user.email).toBe('ada@example.com');
    expect(cred.operationType).toBe('signIn');
    expect(cred.providerId).toBeNull();
    // First-time email-link sign-in IS a sign-up.
    expect(getAdditionalUserInfo(cred)!.isNewUser).toBe(true);
    // Redeeming a code mailed to the address proves control of it.
    expect(cred.user.emailVerified).toBe(true);
  });

  it('reports isNewUser: false when the account already existed', async () => {
    const auth = freshAuth();
    await createUserWithEmailAndPassword(auth, 'ada@example.com', 'pw123456');
    await signOut(auth);

    await sendSignInLinkToEmail(auth, 'ada@example.com', SETTINGS);
    const mail = authSandbox.takeAuthMail(auth)!;
    const cred = await signInWithEmailLink(auth, 'ada@example.com', mail.link);
    expect(getAdditionalUserInfo(cred)!.isNewUser).toBe(false);
  });

  it('is single-use — replaying the same link throws invalid-action-code', async () => {
    const auth = freshAuth();
    await sendSignInLinkToEmail(auth, 'ada@example.com', SETTINGS);
    const mail = authSandbox.takeAuthMail(auth)!;
    await signInWithEmailLink(auth, 'ada@example.com', mail.link);
    await signOut(auth);
    await expectCode(signInWithEmailLink(auth, 'ada@example.com', mail.link), 'auth/invalid-action-code');
  });

  it('refuses a link issued for a DIFFERENT address', async () => {
    const auth = freshAuth();
    await sendSignInLinkToEmail(auth, 'ada@example.com', SETTINGS);
    const mail = authSandbox.takeAuthMail(auth)!;
    // The reason upstream makes the caller supply the email: so it can be
    // compared against the one the link was issued for.
    await expectCode(signInWithEmailLink(auth, 'eve@example.com', mail.link), 'auth/invalid-email');
  });

  it('rejects a link with no oobCode client-side', async () => {
    const auth = freshAuth();
    await expectCode(
      signInWithEmailLink(auth, 'ada@example.com', 'https://x.test/f?mode=signIn&apiKey=K'),
      'auth/argument-error',
    );
  });

  it('an account born from an email link has no password until one is set', async () => {
    const auth = freshAuth();
    await sendSignInLinkToEmail(auth, 'ada@example.com', SETTINGS);
    const mail = authSandbox.takeAuthMail(auth)!;
    await signInWithEmailLink(auth, 'ada@example.com', mail.link);
    await signOut(auth);
    await expectCode(
      signInWithEmailAndPassword(auth, 'ada@example.com', 'anything123'),
      'auth/wrong-password',
    );
  });
});

describe('email verification', () => {
  it('sending does NOT verify — only redeeming the code does', async () => {
    const auth = freshAuth();
    await createUserWithEmailAndPassword(auth, 'ada@example.com', 'pw123456');
    const user = auth.currentUser!;
    expect(user.emailVerified).toBe(false);

    await sendEmailVerification(user);
    // THE point of the flow: the mail went out and nothing changed yet.
    expect(auth.currentUser!.emailVerified).toBe(false);

    const mail = authSandbox.takeAuthMail(auth, 'ada@example.com')!;
    expect(mail.operation).toBe(ActionCodeOperation.VERIFY_EMAIL);

    await applyActionCode(auth, mail.code);
    const rec = authSandbox.listUsers(auth).find((u) => u.email === 'ada@example.com')!;
    expect(rec.emailVerified).toBe(true);
  });

  it('throws missing-email for an anonymous user', async () => {
    const auth = freshAuth();
    const { signInAnonymously } = await import('../../src/auth/index.js');
    await signInAnonymously(auth);
    await expectCode(sendEmailVerification(auth.currentUser!), 'auth/missing-email');
  });
});

describe('password reset', () => {
  it('closes the loop: reset code sets a new password the user can sign in with', async () => {
    const auth = freshAuth();
    await createUserWithEmailAndPassword(auth, 'ada@example.com', 'oldpw123');
    await signOut(auth);

    await sendPasswordResetEmail(auth, 'ada@example.com');
    const mail = authSandbox.takeAuthMail(auth)!;
    expect(mail.operation).toBe(ActionCodeOperation.PASSWORD_RESET);

    // verifyPasswordResetCode inspects WITHOUT burning the code.
    expect(await verifyPasswordResetCode(auth, mail.code)).toBe('ada@example.com');

    await confirmPasswordReset(auth, mail.code, 'newpw456');

    // The real state change: new password works, old one does not.
    const cred = await signInWithEmailAndPassword(auth, 'ada@example.com', 'newpw456');
    expect(cred.user.email).toBe('ada@example.com');
    await signOut(auth);
    await expectCode(signInWithEmailAndPassword(auth, 'ada@example.com', 'oldpw123'), 'auth/wrong-password');
  });

  it('does not leak account existence for an unknown address', async () => {
    const auth = freshAuth();
    // Resolves, and mails nothing — Email Enumeration Protection (oracle-pinned).
    await expect(sendPasswordResetEmail(auth, 'nobody@example.com')).resolves.toBeUndefined();
    expect(authSandbox.listAuthMail(auth)).toEqual([]);
  });

  it('a weak new password does NOT burn the reset code', async () => {
    const auth = freshAuth();
    await createUserWithEmailAndPassword(auth, 'ada@example.com', 'oldpw123');
    await signOut(auth);
    await sendPasswordResetEmail(auth, 'ada@example.com');
    const mail = authSandbox.takeAuthMail(auth)!;

    // A typo must not destroy the user's one reset link.
    await expectCode(confirmPasswordReset(auth, mail.code, 'x'), 'auth/weak-password');
    // Still redeemable.
    await confirmPasswordReset(auth, mail.code, 'goodpw789');
    await signInWithEmailAndPassword(auth, 'ada@example.com', 'goodpw789');
  });

  it('rejects an invalid code', async () => {
    const auth = freshAuth();
    await expectCode(applyActionCode(auth, 'never-issued'), 'auth/invalid-action-code');
    await expectCode(checkActionCode(auth, 'never-issued'), 'auth/invalid-action-code');
    await expectCode(verifyPasswordResetCode(auth, 'never-issued'), 'auth/invalid-action-code');
    await expectCode(confirmPasswordReset(auth, 'never-issued', 'pw123456'), 'auth/invalid-action-code');
  });
});

describe('verifyBeforeUpdateEmail', () => {
  it('does not change the email until the mailed code is redeemed', async () => {
    const auth = freshAuth();
    await createUserWithEmailAndPassword(auth, 'old@example.com', 'pw123456');
    const user = auth.currentUser!;

    await verifyBeforeUpdateEmail(user, 'new@example.com');
    // The whole difference between this and a bare updateEmail.
    expect(auth.currentUser!.email).toBe('old@example.com');

    // The code is mailed TO the new address — that is what makes redeeming
    // it proof of control.
    const mail = authSandbox.takeAuthMail(auth, 'new@example.com')!;
    expect(mail.operation).toBe(ActionCodeOperation.VERIFY_AND_CHANGE_EMAIL);

    const info = await checkActionCode(auth, mail.code);
    expect(info.data.email).toBe('new@example.com');
    expect(info.data.previousEmail).toBe('old@example.com');

    await applyActionCode(auth, mail.code);
    const rec = authSandbox.listUsers(auth).find((u) => u.uid === user.uid)!;
    expect(rec.email).toBe('new@example.com');
    // The new address arrives verified — the user just proved they control it.
    expect(rec.emailVerified).toBe(true);
    // ...and the account now signs in under the new address.
    await signOut(auth);
    await signInWithEmailAndPassword(auth, 'new@example.com', 'pw123456');
  });
});

describe('checkActionCode / expiry', () => {
  it('checkActionCode inspects without burning the code', async () => {
    const auth = freshAuth();
    await createUserWithEmailAndPassword(auth, 'ada@example.com', 'pw123456');
    await sendEmailVerification(auth.currentUser!);
    const mail = authSandbox.takeAuthMail(auth)!;

    const info = await checkActionCode(auth, mail.code);
    expect(info.operation).toBe(ActionCodeOperation.VERIFY_EMAIL);
    // Still live after the check — otherwise a check would destroy the code
    // the apply needs.
    await applyActionCode(auth, mail.code);
  });

  it('a code staged as expired throws expired-action-code', async () => {
    const auth = freshAuth();
    await createUserWithEmailAndPassword(auth, 'ada@example.com', 'pw123456');
    // The expiry branch is otherwise unreachable — in the sandbox AND in
    // production, short of waiting out a real TTL.
    authSandbox.mockActionCode(auth, 'stale-code', {
      operation: ActionCodeOperation.VERIFY_EMAIL,
      email: 'ada@example.com',
      expired: true,
    });
    await expectCode(applyActionCode(auth, 'stale-code'), 'auth/expired-action-code');
    await expectCode(checkActionCode(auth, 'stale-code'), 'auth/expired-action-code');
  });

  it('applyActionCode refuses a password-reset code (confirmPasswordReset owns it)', async () => {
    const auth = freshAuth();
    await createUserWithEmailAndPassword(auth, 'ada@example.com', 'pw123456');
    await signOut(auth);
    await sendPasswordResetEmail(auth, 'ada@example.com');
    const mail = authSandbox.takeAuthMail(auth)!;
    // A reset code carries no new password, so applyActionCode has nothing
    // to apply.
    await expectCode(applyActionCode(auth, mail.code), 'auth/invalid-action-code');
  });
});

describe('the mail resolver seam', () => {
  it('notifies an installed resolver for every message', async () => {
    const auth = freshAuth();
    const seen: string[] = [];
    authSandbox.setAuthMailResolver(auth, { deliver: (m) => seen.push(m.operation) });

    await sendSignInLinkToEmail(auth, 'ada@example.com', SETTINGS);
    await createUserWithEmailAndPassword(auth, 'bob@example.com', 'pw123456');
    await sendEmailVerification(auth.currentUser!);

    expect(seen).toEqual([ActionCodeOperation.EMAIL_SIGNIN, ActionCodeOperation.VERIFY_EMAIL]);
  });

  it('a throwing resolver does not fail the send that produced it', async () => {
    const auth = freshAuth();
    authSandbox.setAuthMailResolver(auth, {
      deliver: () => {
        throw new Error('host UI blew up');
      },
    });
    // A host that fails to render a link must not break the auth call.
    await expect(sendSignInLinkToEmail(auth, 'ada@example.com', SETTINGS)).resolves.toBeUndefined();
    // ...and the message is still in the outbox.
    expect(authSandbox.takeAuthMail(auth)).not.toBeNull();
  });
});
