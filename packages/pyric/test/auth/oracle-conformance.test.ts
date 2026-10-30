/**
 * Oracle conformance — wires `packages/conformance/observations/auth/auth-*.json` into the
 * test suite so the captured real-Firebase behavior is MACHINE-CHECKED against
 * the sandbox shim, not just cited in comments (audit H5: the oracle was
 * decorative; H6 — a committed capture contradicting the shim — went unnoticed
 * because nothing loaded these files).
 *
 * Pattern: each test loads its observation and replays the scenario against the
 * sandbox, asserting the environment-independent facts the capture recorded
 * (fire counts, error codes, null-ness, ordering). The JSON's values are the
 * EXPECTED side wherever sensible — if a capture is re-run against prod and a
 * value changes, the test fails and surfaces the drift. Prod-specific noise
 * (real UIDs, JWT lengths, wall-clock timestamps) is not asserted.
 *
 * Every auth observation in the directory must be either asserted here or
 * explicitly listed in NOT_APPLICABLE with a reason — the completeness test at
 * the bottom enforces that, so a new capture can't silently go un-checked.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createObservationGate } from '../../../../packages/conformance/src/observation-gate.ts';
import { getClock, initializeSandbox } from 'pyric/sandbox';
import {
  ActionCodeOperation,
  applyActionCode,
  AuthErrorCodes,
  checkActionCode,
  confirmPasswordReset,
  deleteUser,
  EmailAuthProvider,
  getAdditionalUserInfo,
  getAuth,
  linkWithCredential,
  reauthenticateWithCredential,
  updatePassword,
  updateProfile,
  verifyBeforeUpdateEmail,
  verifyPasswordResetCode,
  isSignInWithEmailLink,
  onAuthStateChanged,
  onIdTokenChanged,
  OperationType,
  parseActionCodeURL,
  ProviderId,
  sendEmailVerification,
  sendPasswordResetEmail,
  sendSignInLinkToEmail,
  signInAnonymously,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signInWithEmailLink,
  SignInMethod,
  createUserWithEmailAndPassword,
  signOut,
  unlink,
  validatePassword,
  sandbox as authSandbox,
  type User,
} from '../../src/auth/index.js';

// auth-* observations live under the 'auth' surface subdirectory.
const OBS_DIR = join(import.meta.dir, '..', '..', '..', '..', 'packages', 'conformance', 'observations', 'auth');

/**
 * Observations that cannot be replayed against the sandbox, with the reason.
 *
 * ─── The project-configuration history ─────────────────────────────────
 * The auth resolver climb was first captured on a project with the
 * Email/Password provider disabled, so many arms came back
 * `auth/operation-not-allowed`. That was the project's configuration
 * answering first, not the API contract, so those captures were never
 * asserted here. The oracle project now has Email/Password on (and Email
 * Enumeration Protection on), and the linking, verifyBeforeUpdateEmail and
 * action-code probes were re-captured and are replayed below. The one entry
 * still listed for this family is fetchSignInMethodsForEmail, which the
 * sandbox does not implement.
 */
const NOT_APPLICABLE: Record<string, string> = {
  'auth-bare-getauth-no-default-app.json':
    'exercises the prod fallthrough (fb.getAuth with no default app) — covered by the prod path, not sandbox behavior',
  'auth-reauthenticate-with-credential.json':
    'BLOCKED: the committed capture is from a project with the Email/Password provider disabled, so the probe could not create the two accounts it needs. The re-capture waits on the enumeration-protection decision in #1689. Reauth rows are unit-backed.',
  'auth-fetchsigninmethodsforemail-deprecated.json':
    'fetchSignInMethodsForEmail is not implemented (disposition auth.email-enumeration), so there is nothing in the sandbox to replay. The capture backs the disposition: with Email Enumeration Protection on, production returned an empty list for both an account that has a password method and an unknown address. See packages/conformance/surfaces/auth.json.',
};

// Instrumented completeness gate: `load(name)` records which behavior fields are
// read so the completeness test can fail an observation that is only mentioned in
// a comment or loaded but never asserted. See
// `packages/conformance/src/observation-gate.ts` for the mechanism and its limits.
// Replays of a whole capture live in `oracle-captures/`, one file per
// observation; the directory is the index.
const CAPTURE_REPLAYS = join(import.meta.dir, 'oracle-captures');

const obsGate = createObservationGate({
  dir: OBS_DIR,
  match: (f) => f.startsWith('auth-'),
  notApplicable: NOT_APPLICABLE,
  siblingSources: readdirSync(CAPTURE_REPLAYS)
    .filter((file) => file.endsWith('.test.ts'))
    .map((file) => join(CAPTURE_REPLAYS, file)),
});

function load(name: string): Record<string, unknown> {
  return obsGate.load(name);
}

/** Drain the microtask queue a few times — the shim's initial listener fire is
 *  queueMicrotask-deferred (matching prod's async initial fire). */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

function freshAuth() {
  return getAuth(initializeSandbox());
}

function recorder() {
  const fires: Array<string | null> = [];
  const fn = (u: User | null) => fires.push(u?.uid ?? null);
  return { fires, fn };
}

async function expectCode(p: Promise<unknown>, code: string): Promise<Error> {
  try {
    await p;
  } catch (e) {
    expect((e as { code: string }).code).toBe(code);
    return e as Error;
  }
  throw new Error(`expected ${code} to be thrown`);
}

describe('oracle conformance (auth)', () => {
  // ── credentials ──────────────────────────────────────────────────────

  it('auth-anonymous-credential-providerid', async () => {
    const obs = load('auth-anonymous-credential-providerid.json');
    const cred = await signInAnonymously(freshAuth());
    expect(cred.providerId).toBe(obs.providerId as null);
    expect(cred.operationType).toBe(obs.operationType as 'signIn');
    expect(cred.user.isAnonymous).toBe(obs.userIsAnonymous as boolean);
    expect(cred.user.email).toBe(obs.userEmail as null);
  });

  it('auth-createUser-operationType (the audit-H6 field)', async () => {
    const obs = load('auth-createUser-operationType.json');
    const cred = await createUserWithEmailAndPassword(freshAuth(), 'create@example.com', 'pw123456');
    expect(cred.operationType).toBe(obs.operationType as 'signIn');
    // The exact field the committed capture contradicted: prod says null.
    expect(cred.providerId).toBe(obs.providerId as null);
    expect(cred.user.isAnonymous).toBe(obs.userIsAnonymous as boolean);
  });

  // ── error codes ──────────────────────────────────────────────────────

  it('auth-row-18-invalid-email-error-code', async () => {
    const obs = load('auth-row-18-invalid-email-error-code.json');
    await expectCode(
      createUserWithEmailAndPassword(freshAuth(), obs.attemptedEmail as string, 'pw123456'),
      obs.code as string,
    );
  });

  it('auth-row-19-weak-password-error-code', async () => {
    const obs = load('auth-row-19-weak-password-error-code.json');
    await expectCode(
      createUserWithEmailAndPassword(freshAuth(), 'weak@example.com', 'abc'),
      obs.code as string,
    );
  });

  it('auth-email-already-in-use-error-code', async () => {
    const obs = load('auth-email-already-in-use-error-code.json');
    const auth = freshAuth();
    await createUserWithEmailAndPassword(auth, 'dup@example.com', 'pw123456');
    await expectCode(
      createUserWithEmailAndPassword(auth, 'dup@example.com', 'pw123456'),
      obs.code as string,
    );
  });

  it('auth-user-not-found-error-code', async () => {
    const obs = load('auth-user-not-found-error-code.json');
    await expectCode(
      signInWithEmailAndPassword(freshAuth(), 'never-registered@example.com', 'pw123456'),
      obs.code as string,
    );
  });

  it('auth-wrong-password-error-code', async () => {
    const obs = load('auth-wrong-password-error-code.json');
    const auth = freshAuth();
    authSandbox.seedUsers(auth, [{ uid: 'wp', email: 'wp@example.com', password: 'correct123' }]);
    await expectCode(
      signInWithEmailAndPassword(auth, 'wp@example.com', 'wrong9999'),
      obs.code as string,
    );
  });

  // ── tokens ───────────────────────────────────────────────────────────

  it('auth-getidtoken-force-refresh', async () => {
    const obs = load('auth-getidtoken-force-refresh.json');
    const auth = freshAuth();
    const { user } = await signInAnonymously(auth);
    const t0 = await user.getIdToken();
    const t1 = await user.getIdToken(true);
    const t2 = await user.getIdToken();
    expect(t0 !== t1).toBe(obs.forceRefreshReturnedDifferentString as boolean);
    expect(t0 === t1).toBe(obs.token0EqualsToken1 as boolean);
    expect(t1 === t2).toBe(obs.token1EqualsToken2 as boolean);
  });

  it('auth-onidtokenchanged-force-refresh', async () => {
    const obs = load('auth-onidtokenchanged-force-refresh.json');
    const auth = freshAuth();
    const { fires, fn } = recorder();
    onIdTokenChanged(auth, fn);
    await settle();
    const { user } = await signInAnonymously(auth);
    await settle();
    expect(fires.length).toBe(obs.firesAfterSignIn as number);
    await user.getIdToken(true);
    await settle();
    expect(fires.length).toBe(obs.firesAfterRefresh as number);
    expect(fires.length > (obs.firesAfterSignIn as number)).toBe(obs.refreshFiredListener as boolean);
  });

  // ── observer semantics ───────────────────────────────────────────────

  it('auth-row-29-onauthstatechanged-initial-fire-timing', async () => {
    const obs = load('auth-row-29-onauthstatechanged-initial-fire-timing.json');
    const auth = freshAuth();
    await signInAnonymously(auth);
    await settle();
    const { fires, fn } = recorder();
    onAuthStateChanged(auth, fn);
    expect(fires.length).toBe(obs.firedSynchronously as number); // 0 — never sync
    await settle();
    expect(fires.length).toBe(obs.firedAfterMicrotask as number); // 1
  });

  it('auth-row-40-onidtokenchanged-matches-onauthstatechanged-initial-fire', async () => {
    const obs = load('auth-row-40-onidtokenchanged-matches-onauthstatechanged-initial-fire.json') as {
      sync: { auth: number; idToken: number };
      microtask: { auth: number; idToken: number };
      sameInitialCount: boolean;
    };
    const auth = freshAuth();
    const a = recorder();
    const b = recorder();
    onAuthStateChanged(auth, a.fn);
    onIdTokenChanged(auth, b.fn);
    expect(a.fires.length).toBe(obs.sync.auth);
    expect(b.fires.length).toBe(obs.sync.idToken);
    await settle();
    expect(a.fires.length).toBe(obs.microtask.auth);
    expect(b.fires.length).toBe(obs.microtask.idToken);
    expect(a.fires.length === b.fires.length).toBe(obs.sameInitialCount);
  });

  it('auth-row-10-onauthstatechanged-one-per-transition', async () => {
    const obs = load('auth-row-10-onauthstatechanged-one-per-transition.json');
    const auth = freshAuth();
    const { fires, fn } = recorder();
    onAuthStateChanged(auth, fn);
    await settle();
    expect(fires.length).toBe(obs.initialFires as number);
    await signInAnonymously(auth);
    await settle();
    expect(fires.length).toBe(obs.afterSignIn1 as number);
    await signOut(auth);
    await settle();
    expect(fires.length).toBe(obs.afterSignOut as number);
    authSandbox.seedUsers(auth, [{ uid: 'u2', email: 'u2@example.com', password: 'pw123456' }]);
    await signInWithEmailAndPassword(auth, 'u2@example.com', 'pw123456');
    await settle();
    expect(fires.length).toBe(obs.afterSignIn2 as number);
  });

  it('auth-row-17-signin-email-password-fires-once', async () => {
    const obs = load('auth-row-17-signin-email-password-fires-once.json');
    const auth = freshAuth();
    authSandbox.seedUsers(auth, [{ uid: 'r17', email: 'r17@example.com', password: 'pw123456' }]);
    const { fires, fn } = recorder();
    onAuthStateChanged(auth, fn);
    await settle();
    await signInWithEmailAndPassword(auth, 'r17@example.com', 'pw123456');
    await settle();
    expect(fires.length).toBe(obs.afterSignIn as number);
    expect(fires.at(-1)).toBe('r17'); // lastFireUidMatches
  });

  it('auth-row-24-createuser-fires-once', async () => {
    const obs = load('auth-row-24-createuser-fires-once.json');
    const auth = freshAuth();
    const { fires, fn } = recorder();
    onAuthStateChanged(auth, fn);
    await settle();
    const cred = await createUserWithEmailAndPassword(auth, 'r24@example.com', 'pw123456');
    await settle();
    expect(fires.length).toBe(obs.afterCreate as number);
    expect(fires.at(-1)).toBe(cred.user.uid); // lastFireUidMatches
  });

  it('auth-row-25-signout-currentuser-null-sync', async () => {
    const obs = load('auth-row-25-signout-currentuser-null-sync.json');
    const auth = freshAuth();
    await signInAnonymously(auth);
    expect(auth.currentUser).not.toBeNull();
    await signOut(auth);
    // currentUserIsNullSync — null immediately after the awaited promise.
    expect(auth.currentUser === null).toBe(obs.currentUserIsNullSync as boolean);
    await settle();
    expect(auth.currentUser).toBeNull();
  });

  it('auth-row-26-signout-fires-null-once', async () => {
    const obs = load('auth-row-26-signout-fires-null-once.json');
    const auth = freshAuth();
    const { fires, fn } = recorder();
    onAuthStateChanged(auth, fn);
    await settle();
    await signInAnonymously(auth);
    await settle();
    await signOut(auth);
    await settle();
    expect(fires.length).toBe(obs.afterSignOut as number);
    expect(fires.at(-1) === null).toBe(obs.lastFireUidWasNull as boolean);
  });

  it('auth-row-30-onauthstatechanged-fires-on-every-transition', async () => {
    const obs = load('auth-row-30-onauthstatechanged-fires-on-every-transition.json');
    const auth = freshAuth();
    authSandbox.seedUsers(auth, [{ uid: 't3', email: 't3@example.com', password: 'pw123456' }]);
    const { fires, fn } = recorder();
    onAuthStateChanged(auth, fn);
    await settle();
    const counts: number[] = [];
    await signInAnonymously(auth);
    await settle();
    counts.push(fires.length);
    await signOut(auth);
    await settle();
    counts.push(fires.length);
    await signInWithEmailAndPassword(auth, 't3@example.com', 'pw123456');
    await settle();
    counts.push(fires.length);
    await signOut(auth);
    await settle();
    counts.push(fires.length);
    // each transition fired exactly once: 2,3,4,5 after the initial 1
    expect(counts).toEqual([2, 3, 4, 5]);
    expect(obs.eachTransitionFiredExactlyOnce).toBe(true);
  });

  it('auth-row-31-onauthstatechanged-no-dup-on-sync-transition (KNOWN DIVERGENCE)', async () => {
    // Prod capture: subscribe → signInAnonymously with no await-gap fires 2
    // ([null, user]) — prod's sign-in is network-async, so the microtask
    // initial-null lands BEFORE the user fire. The sandbox's sign-in is
    // same-tick: setCurrentUser fans out `user` synchronously, and the queued
    // initial-fire microtask then dedups (lastDelivered === cachedUser), so the
    // sandbox fires 1 ([user]) — the initial null is swallowed. Reproducing
    // prod's sequence requires deferring ALL listener fan-outs to microtasks
    // (a timing-model change with real blast radius) — tracked as a follow-up,
    // not silently absorbed here. This test pins BOTH sides so neither can
    // drift unnoticed: the oracle's value, and the sandbox's current behavior.
    const obs = load('auth-row-31-onauthstatechanged-no-dup-on-sync-transition.json');
    expect(obs.totalFires).toBe(2); // what prod did (the target)
    const auth = freshAuth();
    const { fires, fn } = recorder();
    onAuthStateChanged(auth, fn);
    await signInAnonymously(auth); // no await-gap between subscribe and sign-in
    await settle();
    expect(fires.length).toBe(1); // sandbox today: [user], initial null swallowed
    expect(fires.some((u) => u !== null)).toBe(obs.sawNewUser as boolean);
    // NOT asserted: obs.sawInitialNull (true in prod, false in sandbox) — the
    // divergence under track. If a timing-model fix lands, this test fails
    // here and should flip to assert the oracle's totalFires/sawInitialNull.
  });

  it('auth-row-32-unsubscribe-stops-fires', async () => {
    const obs = load('auth-row-32-unsubscribe-stops-fires.json');
    const auth = freshAuth();
    const { fires, fn } = recorder();
    const unsub = onAuthStateChanged(auth, fn);
    await settle();
    await signInAnonymously(auth);
    await settle();
    const atUnsub = fires.length;
    expect(atUnsub).toBe(obs.firesAtUnsubscribe as number);
    unsub();
    await signOut(auth);
    await signInAnonymously(auth);
    await signOut(auth);
    await settle();
    expect(fires.length - atUnsub).toBe(obs.postUnsubFires as number); // 0
  });

  it('auth-row-33-multiple-subscribers-all-fire', async () => {
    const obs = load('auth-row-33-multiple-subscribers-all-fire.json');
    const auth = freshAuth();
    const a = recorder();
    const b = recorder();
    onAuthStateChanged(auth, a.fn);
    onAuthStateChanged(auth, b.fn);
    await settle();
    await signInAnonymously(auth);
    await settle();
    expect(a.fires.length).toBe(obs.afterSignInA as number);
    expect(b.fires.length).toBe(obs.afterSignInB as number);
    await signOut(auth);
    await settle();
    expect(a.fires.length).toBe(obs.afterSignOutA as number);
    expect(b.fires.length).toBe(obs.afterSignOutB as number);
  });

  it('auth-row-35-throwing-observer-doesnt-block-others', async () => {
    const obs = load('auth-row-35-throwing-observer-doesnt-block-others.json') as {
      afterSignIn: { firstFireCount: number; secondFireCount: number };
      secondObserverContinuedFiring: boolean;
    };
    const auth = freshAuth();
    let firstCount = 0;
    let secondCount = 0;
    onAuthStateChanged(auth, () => {
      firstCount++;
      throw new Error('observer boom');
    });
    onAuthStateChanged(auth, () => {
      secondCount++;
    });
    await settle();
    await signInAnonymously(auth);
    await settle();
    expect(firstCount).toBe(obs.afterSignIn.firstFireCount);
    expect(secondCount).toBe(obs.afterSignIn.secondFireCount);
    expect(secondCount >= 2).toBe(obs.secondObserverContinuedFiring);
  });

  it('auth-row-36-observer-object-form-works', async () => {
    const obs = load('auth-row-36-observer-object-form-works.json');
    const auth = freshAuth();
    const fn = recorder();
    const objFires: Array<string | null> = [];
    onAuthStateChanged(auth, fn.fn);
    onAuthStateChanged(auth, { next: (u) => objFires.push(u?.uid ?? null) });
    await settle();
    await signInAnonymously(auth);
    await settle();
    expect(fn.fires.length).toBe(obs.afterSignInFn as number);
    expect(objFires.length).toBe(obs.afterSignInObs as number);
    await signOut(auth);
    await settle();
    expect(fn.fires.length).toBe(obs.afterSignOutFn as number);
    expect(objFires.length).toBe(obs.afterSignOutObs as number);
  });

  it('auth-row-37-same-user-no-double-fire', async () => {
    const obs = load('auth-row-37-same-user-no-double-fire.json');
    const auth = freshAuth();
    const { fires, fn } = recorder();
    onAuthStateChanged(auth, fn);
    await settle();
    const c1 = await signInAnonymously(auth);
    await settle();
    expect(fires.length).toBe(obs.afterFirstSignIn as number);
    const c2 = await signInAnonymously(auth);
    await settle();
    expect(fires.length).toBe(obs.afterSecondSignIn as number); // no extra fire
    expect(c1.user.uid === c2.user.uid).toBe(obs.sameUserAcrossCalls as boolean);
  });

  it('auth-row-38-onidtokenchanged-fires-on-user-change', async () => {
    const obs = load('auth-row-38-onidtokenchanged-fires-on-user-change.json');
    const auth = freshAuth();
    authSandbox.seedUsers(auth, [{ uid: 'r38', email: 'r38@example.com', password: 'pw123456' }]);
    const { fires, fn } = recorder();
    onIdTokenChanged(auth, fn);
    await settle();
    await signInAnonymously(auth);
    await settle();
    expect(fires.length).toBe(obs.afterSignIn1 as number);
    await signOut(auth);
    await settle();
    expect(fires.length).toBe(obs.afterSignOut as number);
    await signInWithEmailAndPassword(auth, 'r38@example.com', 'pw123456');
    await settle();
    expect(fires.length).toBe(obs.afterSignIn2 as number);
  });

  it('auth-signout-idempotent', async () => {
    const obs = load('auth-signout-idempotent.json');
    const auth = freshAuth();
    const { fires, fn } = recorder();
    onAuthStateChanged(auth, fn);
    await settle();
    await signInAnonymously(auth);
    await settle();
    await signOut(auth);
    await settle();
    expect(fires.length).toBe(obs.baselineFires as number);
    let threw = false;
    try {
      await signOut(auth); // redundant
    } catch {
      threw = true;
    }
    await settle();
    expect(threw).toBe(obs.threw as boolean);
    expect(fires.length).toBe(obs.afterRedundantSignOut as number);
  });

  // ── round-3 P4 captures ────────────────────────────────────────────────

  it('auth-signinprovider-per-flow', async () => {
    const obs = load('auth-signinprovider-per-flow.json') as {
      anonymous: { signInProvider: string; firebaseClaim: string };
      password: { signInProvider: string; firebaseClaim: string };
    };
    const anonAuth = freshAuth();
    await signInAnonymously(anonAuth);
    const anonRes = await anonAuth.currentUser!.getIdTokenResult();
    expect(anonRes.signInProvider).toBe(obs.anonymous.signInProvider);
    expect((anonRes.claims as { firebase?: { sign_in_provider?: string } }).firebase?.sign_in_provider)
      .toBe(obs.anonymous.firebaseClaim);

    const pwAuth = freshAuth();
    await createUserWithEmailAndPassword(pwAuth, 'provider@example.com', 'pw123456');
    const pwRes = await pwAuth.currentUser!.getIdTokenResult();
    expect(pwRes.signInProvider).toBe(obs.password.signInProvider);
    expect((pwRes.claims as { firebase?: { sign_in_provider?: string } }).firebase?.sign_in_provider)
      .toBe(obs.password.firebaseClaim);
  });

  it('auth-claims-forced-refresh-propagation', async () => {
    const obs = load('auth-claims-forced-refresh-propagation.json') as {
      claimBefore: unknown;
      claimForcedRefresh: unknown;
    };
    const auth = freshAuth();
    await createUserWithEmailAndPassword(auth, 'claims@example.com', 'pw123456');
    const user = auth.currentUser!;
    const before = await user.getIdTokenResult();
    expect((before.claims as Record<string, unknown>).oracleRole ?? null).toEqual(obs.claimBefore);
    authSandbox.updateUser(auth, user.uid, { customClaims: { oracleRole: 'admin' } });
    const forced = await user.getIdTokenResult(true);
    expect((forced.claims as Record<string, unknown>).oracleRole).toEqual(obs.claimForcedRefresh);
    // Prod nuance the oracle pinned: an UNFORCED read after the admin write
    // still serves the cached token (claimUnforcedAfterAdminWrite: null).
    // The sandbox reads claims live at mint time but only re-mints on
    // force — matching the forced-refresh propagation story.
  });

  // ── the auth resolver climb: email-link / action-code, linking, reauth ──
  //
  // Read the note above NOT_APPLICABLE before adding to this block. Assert
  // only what production actually told us; an arm the project's
  // configuration answered first is not API evidence.

  it('auth-actioncodeurl-parse', () => {
    const obs = load('auth-actioncodeurl-parse.json') as {
      wellFormed: Record<string, unknown>;
      signInOperation: string;
      noModeIsNull: boolean;
      noCodeIsNull: boolean;
      notAUrlIsNull: boolean;
      actionCodeOperation: Record<string, string>;
    };
    // The PURE parse contract — no network, no project, so the sandbox owes
    // production an exact match here and there is no excuse for a divergence.
    const parsed = parseActionCodeURL(
      'https://example.com/finish?mode=resetPassword&oobCode=CODE_123&apiKey=API_KEY_1&continueUrl=https%3A%2F%2Fapp.example.com%2Fnext&lang=fr',
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.operation).toBe(obs.wellFormed.operation as string);
    expect(parsed!.code).toBe(obs.wellFormed.code as string);
    expect(parsed!.apiKey).toBe(obs.wellFormed.apiKey as string);
    // continueUrl comes out URL-DECODED — prod decodes it, so we must too.
    expect(parsed!.continueUrl).toBe(obs.wellFormed.continueUrl as string);
    expect(parsed!.languageCode).toBe(obs.wellFormed.languageCode as string);
    expect(parsed!.tenantId).toBe(obs.wellFormed.tenantId as null);

    // mode=signIn normalizes to EMAIL_SIGNIN, not 'signIn'.
    const signIn = parseActionCodeURL('https://example.com/finish?mode=signIn&oobCode=C&apiKey=K');
    expect(signIn!.operation).toBe(obs.signInOperation);

    // The three null cases — the parse never throws.
    expect(parseActionCodeURL('https://example.com/f?oobCode=X&apiKey=K') === null).toBe(obs.noModeIsNull);
    expect(parseActionCodeURL('https://example.com/f?mode=signIn&apiKey=K') === null).toBe(obs.noCodeIsNull);
    expect(parseActionCodeURL('definitely not a url') === null).toBe(obs.notAUrlIsNull);

    // The operation constant map, value for value.
    expect({ ...ActionCodeOperation }).toEqual(obs.actionCodeOperation);
  });

  it('auth-issigninwithemaillink-predicate', () => {
    const obs = load('auth-issigninwithemaillink-predicate.json') as Record<string, boolean>;
    const auth = freshAuth();
    expect(isSignInWithEmailLink(auth, 'https://example.com/x?mode=signIn&oobCode=C1&apiKey=K')).toBe(obs.signInLink);
    expect(isSignInWithEmailLink(auth, 'https://example.com/x?mode=resetPassword&oobCode=C1&apiKey=K')).toBe(obs.resetPasswordLink);
    expect(isSignInWithEmailLink(auth, 'https://example.com/x?mode=signIn&apiKey=K')).toBe(obs.signInModeNoOobCode);
    expect(isSignInWithEmailLink(auth, 'not-a-link')).toBe(obs.garbage);
    expect(isSignInWithEmailLink(auth, '')).toBe(obs.empty);
  });

  it('auth-action-code-invalid', async () => {
    const obs = load('auth-action-code-invalid.json') as Record<string, string>;
    const auth = freshAuth();
    // Every redeem and inspect path answers a code the project never issued
    // with `auth/invalid-action-code`, and so does applyActionCode for the
    // empty string. Assert each arm against the capture.
    const bogus = 'pyric-oracle-not-a-real-oob-code';
    await expectCode(applyActionCode(auth, bogus), obs.applyActionCode!);
    await expectCode(applyActionCode(auth, ''), obs.applyActionCodeEmpty!);
    await expectCode(checkActionCode(auth, bogus), obs.checkActionCode!);
    await expectCode(verifyPasswordResetCode(auth, bogus), obs.verifyPasswordResetCode!);
    await expectCode(confirmPasswordReset(auth, bogus, 'oracle-pw-123'), obs.confirmPasswordReset!);
    expect(obs.checkActionCode).toBe('auth/invalid-action-code');
  });

  it('auth-sendsigninlinktoemail-settings-validation', async () => {
    const obs = load('auth-sendsigninlinktoemail-settings-validation.json') as Record<string, string>;
    const auth = freshAuth();
    // Both of these are CLIENT-side validations — prod threw before any
    // request left the process, so they are project-independent and the
    // sandbox owes an exact match.
    await expectCode(
      sendSignInLinkToEmail(auth, 'ada@example.com', { handleCodeInApp: true } as never),
      obs.missingUrl!,
    );
    await expectCode(
      sendSignInLinkToEmail(auth, 'ada@example.com', { url: 'https://example.com/finish', handleCodeInApp: false }),
      obs.handleCodeInAppFalse!,
    );
    // Worth pinning explicitly, because the constant's NAME misleads: a
    // MISSING url yields `invalid-continue-uri`, not `missing-continue-uri`.
    expect(obs.missingUrl).toBe('auth/invalid-continue-uri');
    expect(obs.handleCodeInAppFalse).toBe('auth/argument-error');
  });

  it('auth-signinwithemaillink-invalid-link', async () => {
    const obs = load('auth-signinwithemaillink-invalid-link.json') as Record<string, string>;
    const auth = freshAuth();
    // A link with no oobCode fails client-side with argument-error — prod
    // never gets far enough to ask the server about a code it cannot find.
    await expectCode(
      signInWithEmailLink(auth, 'ada@example.com', 'https://example.com/x?mode=signIn&apiKey=K'),
      obs.noOobCode!,
    );
    expect(obs.noOobCode).toBe('auth/argument-error');
    // A well-formed link whose code the project never issued reaches the
    // server, which answers `auth/invalid-action-code`.
    await expectCode(
      signInWithEmailLink(auth, 'ada@example.com', 'https://example.com/x?mode=signIn&oobCode=pyric-oracle-unknown&apiKey=K'),
      obs.unknownCode!,
    );
  });

  it('auth-sendpasswordresetemail-unknown-user', async () => {
    const obs = load('auth-sendpasswordresetemail-unknown-user.json') as {
      resolvedForUnknownUser: boolean;
      unknownUserCode: string | null;
      malformedEmailCode: string;
    };
    const auth = freshAuth();
    // THE behavior worth locking: prod does NOT leak account existence. An
    // address nobody owns resolves silently. A sandbox that threw
    // `auth/user-not-found` here would hand agent code an account oracle
    // production deliberately removed.
    expect(obs.resolvedForUnknownUser).toBe(true);
    expect(obs.unknownUserCode).toBeNull();
    await expect(sendPasswordResetEmail(auth, 'nobody-at-all@example.com')).resolves.toBeUndefined();
    // ...and no mail was sent, because there was no account to send it to.
    expect(authSandbox.listAuthMail(auth)).toEqual([]);
    // Format validation still fires.
    await expectCode(sendPasswordResetEmail(auth, 'not-an-email'), obs.malformedEmailCode);
  });

  it('auth-sendemailverification-shape', async () => {
    const obs = load('auth-sendemailverification-shape.json') as { anonymousUserCode: string };
    const auth = freshAuth();
    // An anonymous user has no email to verify. Prod: `auth/missing-email`.
    await signInAnonymously(auth);
    await expectCode(sendEmailVerification(auth.currentUser!), obs.anonymousUserCode);
    expect(obs.anonymousUserCode).toBe('auth/missing-email');
  });

  it('auth-unlink-provider', async () => {
    const obs = load('auth-unlink-provider.json') as { noSuchProviderCode: string };
    const auth = freshAuth();
    // The one linking fact the oracle DID reach (it needs no email
    // credential): unlinking a provider that was never linked.
    await signInAnonymously(auth);
    await expectCode(unlink(auth.currentUser!, 'google.com'), obs.noSuchProviderCode);
    expect(obs.noSuchProviderCode).toBe('auth/no-such-provider');
  });

  it('auth-additional-user-info-shape (KNOWN DIVERGENCE, #1699)', async () => {
    type Info = { isNewUser: boolean; providerId: string | null; profile: unknown };
    const obs = load('auth-additional-user-info-shape.json') as {
      anonymous: Info;
      createUser: Info;
      signInExisting: Info;
    };
    const auth = freshAuth();
    const cred = await signInAnonymously(auth);
    const info = getAdditionalUserInfo(cred);
    // Prod: { isNewUser: true, providerId: null, profile: {} }. Note
    // providerId is NULL, not 'anonymous' — anonymous is not a federated
    // provider. A mirror that reported 'anonymous' would break any consumer
    // branching on providerId.
    expect(info!.isNewUser).toBe(obs.anonymous.isNewUser);
    expect(info!.providerId).toBe(obs.anonymous.providerId);
    expect(info!.profile).toEqual(obs.anonymous.profile as Record<string, unknown>);
    await signOut(auth);

    // Email create and returning sign-in: production's getAdditionalUserInfo
    // reports providerId 'password' (from the token's sign-in provider), while
    // UserCredential.providerId stays null (AUTH-B2). The sandbox reports null
    // here (#1699). Both sides are pinned so neither drifts unnoticed; when
    // #1699 lands, assert the sandbox against obs.*.providerId instead.
    expect(obs.createUser.providerId).toBe('password');
    expect(obs.signInExisting.providerId).toBe('password');
    const email = 'additional-info@example.com';
    const created = getAdditionalUserInfo(await createUserWithEmailAndPassword(auth, email, 'oracle-pw-123'));
    expect(created!.isNewUser).toBe(obs.createUser.isNewUser);
    expect(created!.providerId).toBeNull();
    expect(created!.profile).toEqual(obs.createUser.profile as Record<string, unknown>);
    await signOut(auth);
    const returning = getAdditionalUserInfo(await signInWithEmailAndPassword(auth, email, 'oracle-pw-123'));
    expect(returning!.isNewUser).toBe(obs.signInExisting.isNewUser);
    expect(returning!.providerId).toBeNull();
    expect(returning!.profile).toEqual(obs.signInExisting.profile as Record<string, unknown>);
  });

  it('auth-verifybeforeupdateemail-shape (KNOWN DIVERGENCE, #1693)', async () => {
    const obs = load('auth-verifybeforeupdateemail-shape.json') as {
      resolved: boolean;
      emailUnchangedUntilLinkClicked: boolean;
      malformedTargetCode: string;
    };
    const auth = freshAuth();
    const email = 'vbue@example.com';
    await createUserWithEmailAndPassword(auth, email, 'oracle-pw-123');
    await expect(verifyBeforeUpdateEmail(auth.currentUser!, 'vbue-next@example.com')).resolves.toBeUndefined();
    expect(obs.resolved).toBe(true);
    expect(auth.currentUser!.email === email).toBe(obs.emailUnchangedUntilLinkClicked);
    // A malformed new address: production answers auth/invalid-new-email, the
    // sandbox answers auth/invalid-email (#1693). Both sides are pinned; when
    // #1693 lands, assert the sandbox against obs.malformedTargetCode.
    expect(obs.malformedTargetCode).toBe('auth/invalid-new-email');
    await expectCode(verifyBeforeUpdateEmail(auth.currentUser!, 'not-an-email'), 'auth/invalid-email');
  });

  it('auth-link-email-credential-to-anonymous (KNOWN DIVERGENCE, #1698)', async () => {
    const obs = load('auth-link-email-credential-to-anonymous.json') as {
      operationType: string;
      credentialProviderId: string | null;
      uidPreserved: boolean;
      isAnonymousAfterLink: boolean;
      providerIds: string[];
      isCurrentUser: boolean;
      additionalUserInfoIsNewUser: boolean;
      additionalUserInfoProviderId: string | null;
    };
    const auth = freshAuth();
    const anon = await signInAnonymously(auth);
    const linked = await linkWithCredential(anon.user, EmailAuthProvider.credential('link-anon@example.com', 'oracle-pw-123'));
    expect(linked.operationType).toBe(obs.operationType);
    expect(linked.providerId).toBe(obs.credentialProviderId);
    expect(linked.user.uid === anon.user.uid).toBe(obs.uidPreserved);
    expect(linked.user.isAnonymous).toBe(obs.isAnonymousAfterLink);
    expect(linked.user.providerData.map((p) => p.providerId)).toEqual(obs.providerIds);
    expect(auth.currentUser === linked.user).toBe(obs.isCurrentUser);
    // Production reports the upgraded account as a new user with providerId
    // 'password'; the sandbox reports isNewUser false and providerId null
    // (#1698). Both sides are pinned; when #1698 lands, assert the sandbox
    // against obs.additionalUserInfo*.
    expect(obs.additionalUserInfoIsNewUser).toBe(true);
    expect(obs.additionalUserInfoProviderId).toBe('password');
    const info = getAdditionalUserInfo(linked);
    expect(info!.isNewUser).toBe(false);
    expect(info!.providerId).toBeNull();
  });

  it('auth-link-conflicts', async () => {
    const obs = load('auth-link-conflicts.json') as {
      providerAlreadyLinkedCode: string;
      credentialAlreadyInUseCode: string;
      ownerUidDiffersFromB: boolean;
    };
    const auth = freshAuth();
    const password = 'oracle-pw-123';
    const owner = await createUserWithEmailAndPassword(auth, 'owner@example.com', password);
    await signOut(auth);
    const b = await signInAnonymously(auth);
    await linkWithCredential(b.user, EmailAuthProvider.credential('b@example.com', password));
    expect(owner.user.uid !== b.user.uid).toBe(obs.ownerUidDiffersFromB);
    await expectCode(
      linkWithCredential(auth.currentUser!, EmailAuthProvider.credential('b2@example.com', password)),
      obs.providerAlreadyLinkedCode,
    );
    await signOut(auth);
    const c = await signInAnonymously(auth);
    await expectCode(
      linkWithCredential(c.user, EmailAuthProvider.credential('owner@example.com', password)),
      obs.credentialAlreadyInUseCode,
    );
  });

  it('auth-mechanical-surface-constants', () => {
    const obs = load('auth-mechanical-surface-constants.json') as {
      ProviderId: Record<string, string>;
      SignInMethod: Record<string, string>;
      OperationType: Record<string, string>;
      authErrorCodesSample: Record<string, string>;
    };
    // Value-for-value. Consumer code compares against these constants, so a
    // mirror that got a string wrong would turn every such comparison into a
    // silent false — worse than not exporting them at all.
    expect({ ...ProviderId }).toEqual(obs.ProviderId);
    expect({ ...SignInMethod }).toEqual(obs.SignInMethod);
    expect({ ...OperationType }).toEqual(obs.OperationType);
    for (const [name, code] of Object.entries(obs.authErrorCodesSample)) {
      expect((AuthErrorCodes as unknown as Record<string, string>)[name]).toBe(code);
    }
    // The error codes this climb's families actually throw, pinned to the
    // captured map rather than to a string we typed from memory.
    expect(obs.authErrorCodesSample.INVALID_OOB_CODE).toBe('auth/invalid-action-code');
    expect(obs.authErrorCodesSample.EXPIRED_OOB_CODE).toBe('auth/expired-action-code');
    expect(obs.authErrorCodesSample.PROVIDER_ALREADY_LINKED).toBe('auth/provider-already-linked');
    expect(obs.authErrorCodesSample.NO_SUCH_PROVIDER).toBe('auth/no-such-provider');
    expect(obs.authErrorCodesSample.USER_MISMATCH).toBe('auth/user-mismatch');
    // NOTE: the capture's `persistenceTypes` block is deliberately NOT
    // asserted. The harness runs under Node, where firebase/auth stubs the
    // browser-only persistence tokens to `type: 'NONE'` — it reports 'NONE'
    // even for browserLocalPersistence, which is unambiguously 'LOCAL'. The
    // observation is committed as captured (it is what we saw); asserting it
    // would be asserting a harness artifact. See config-tokens.ts.
  });

  it('auth-signinwithcustomtoken-invalid', async () => {
    const obs = load('auth-signinwithcustomtoken-invalid.json') as {
      malformedCode: string;
      emptyCode: string;
    };
    const auth = freshAuth();
    await expectCode(signInWithCustomToken(auth, 'not-a-jwt'), obs.malformedCode);
    await expectCode(signInWithCustomToken(auth, ''), obs.emptyCode);
    expect(obs.malformedCode).toBe('auth/invalid-custom-token');
  });

  it('auth-validatepassword-status-shape', async () => {
    const obs = load('auth-validatepassword-status-shape.json') as {
      weak: Record<string, unknown>;
      strong: Record<string, unknown>;
    };
    const auth = freshAuth();
    const weak = await validatePassword(auth, 'x');
    const strong = await validatePassword(auth, 'aReasonablyStrongPassword123!');
    expect(weak.isValid).toBe(obs.weak.isValid as boolean);
    expect(weak.meetsMinPasswordLength).toBe(obs.weak.meetsMinPasswordLength as boolean);
    expect(weak.meetsMaxPasswordLength).toBe(obs.weak.meetsMaxPasswordLength as boolean);
    expect(strong.isValid).toBe(obs.strong.isValid as boolean);
    // The policy the sandbox reports must be the policy prod reports, or a
    // UI showing live strength feedback draws the line in the wrong place.
    expect(weak.passwordPolicy.customStrengthOptions.minPasswordLength).toBe(obs.weak.minPasswordLength as number);
    expect(weak.passwordPolicy.customStrengthOptions.maxPasswordLength).toBe(obs.weak.maxPasswordLength as number);
    // The character-class requirements are UNSET in prod's policy, and must
    // be unset here — reporting `false` would claim the password failed a
    // rule the project never had.
    expect(weak.containsLowercaseLetter).toBeUndefined();
    expect(obs.weak.containsLowercaseLetter).toBeNull();
  });

  it('auth-requires-recent-login', async () => {
    type Outcome = { code: string | null; message?: string };
    const obs = load('auth-requires-recent-login.json') as {
      freshUpdatePassword: Outcome;
      windowBracket: Array<{ ageSeconds: number; deleteUser: string | null }>;
      forcedRefresh: { issuedAtChanged: boolean; authTimeOlderThanIssuedAt: boolean };
      gated: Record<'updateProfile' | 'getIdTokenForced' | 'updatePassword' | 'verifyBeforeUpdateEmail'
        | 'deleteUser' | 'unlinkPassword' | 'anonymousLinkWithCredential' | 'anonymousDeleteUser'
        | 'afterForcedRefreshUpdatePassword', Outcome> & { ageSeconds: number };
      afterReauth: Record<'reauthenticate' | 'updatePassword' | 'deleteUser', Outcome>;
    };
    const outcome = async (p: Promise<unknown>): Promise<Outcome> => {
      try {
        await p;
        return { code: null };
      } catch (e) {
        const err = e as { code: string; message: string };
        return { code: err.code, message: err.message };
      }
    };
    const password = 'oracle-pw-123';
    let n = 0;
    const emailSession = async (ageSeconds: number) => {
      const sandbox = initializeSandbox();
      const auth = getAuth(sandbox);
      const email = `rrl-${n++}@example.com`;
      const { user } = await createUserWithEmailAndPassword(auth, email, password);
      getClock(sandbox).advance(ageSeconds * 1000);
      return { sandbox, auth, user, email };
    };
    const anonymousSession = async (ageSeconds: number) => {
      const sandbox = initializeSandbox();
      const { user } = await signInAnonymously(getAuth(sandbox));
      getClock(sandbox).advance(ageSeconds * 1000);
      return user;
    };

    const fresh = await emailSession(0);
    expect(await outcome(updatePassword(fresh.user, `${password}-fresh`))).toEqual(obs.freshUpdatePassword);

    for (const { ageSeconds, deleteUser: code } of obs.windowBracket) {
      const s = await emailSession(ageSeconds);
      expect({ ageSeconds, code: (await outcome(deleteUser(s.user))).code }).toEqual({ ageSeconds, code });
    }

    const age = obs.gated.ageSeconds;
    const stale = await emailSession(age);
    const newEmail = 'rrl-new@example.com';
    expect(await outcome(updateProfile(stale.user, { displayName: 'rrl' }))).toEqual(obs.gated.updateProfile);
    expect(await outcome(stale.user.getIdToken(true))).toEqual(obs.gated.getIdTokenForced);
    expect(await outcome(updatePassword(stale.user, `${password}-stale`))).toEqual(obs.gated.updatePassword);
    expect(await outcome(verifyBeforeUpdateEmail(stale.user, newEmail))).toEqual(obs.gated.verifyBeforeUpdateEmail);
    expect(await outcome(deleteUser(stale.user))).toEqual(obs.gated.deleteUser);

    const unlinking = await emailSession(age);
    expect(await outcome(unlink(unlinking.user, 'password'))).toEqual(obs.gated.unlinkPassword);
    const linking = await anonymousSession(age);
    const linkCredential = EmailAuthProvider.credential('rrl-link@example.com', password);
    expect(await outcome(linkWithCredential(linking, linkCredential))).toEqual(obs.gated.anonymousLinkWithCredential);
    const anonymous = await anonymousSession(age);
    expect(await outcome(deleteUser(anonymous))).toEqual(obs.gated.anonymousDeleteUser);

    // A forced refresh mints a new iat and keeps auth_time, so it does not
    // restart the window.
    const refreshing = await emailSession(120);
    const refreshed = await refreshing.user.getIdTokenResult(true);
    expect(refreshed.issuedAtTime !== refreshed.authTime).toBe(obs.forcedRefresh.issuedAtChanged);
    expect(Date.parse(refreshed.authTime) < Date.parse(refreshed.issuedAtTime)).toBe(obs.forcedRefresh.authTimeOlderThanIssuedAt);
    getClock(refreshing.sandbox).advance((age - 120) * 1000);
    expect(await outcome(updatePassword(refreshing.user, `${password}-refresh`))).toEqual(obs.gated.afterForcedRefreshUpdatePassword);

    const credential = EmailAuthProvider.credential(stale.email, password);
    expect(await outcome(reauthenticateWithCredential(stale.user, credential))).toEqual(obs.afterReauth.reauthenticate);
    expect(await outcome(updatePassword(stale.user, `${password}-after`))).toEqual(obs.afterReauth.updatePassword);
    expect(await outcome(deleteUser(stale.user))).toEqual(obs.afterReauth.deleteUser);
  });

  it('auth-id-token-standard-claims', async () => {
    type Arm = { signInProvider: string; claims: Record<string, unknown> };
    const obs = load('auth-id-token-standard-claims.json') as Record<
      | 'anonymous' | 'passwordUnverified' | 'passwordWithProfile' | 'passwordVerifiedWithPhone'
      | 'customClaimsOverlappingStandard' | 'customClaimsOverlappingFullProfile' | 'customClaimsOverlappingAnonymous'
      | 'reservedClaims' | 'customTokenNewUid' | 'customTokenExistingEmailAccount',
      Arm
    >;
    const email = 'claims@example.com';
    const displayName = 'Claims User';
    const photoURL = 'https://example.com/claims.png';
    const phoneNumber = '+16505550100';
    const placeholders = new Map<unknown, string>([
      [email, '<email>'], [displayName, '<displayName>'], [photoURL, '<photoURL>'], [phoneNumber, '<phoneNumber>'],
    ]);
    // The capture's normalization, applied to the sandbox claims. `aud` and
    // `iss` name the real project in production and the sandbox issuer here,
    // so the comparison leaves them out.
    const shape = (value: unknown, key: string | null, uid: string): unknown => {
      if (value === uid) return '<uid>';
      if (placeholders.has(value)) return placeholders.get(value);
      if (key !== null && ['auth_time', 'iat', 'exp'].includes(key)) return `<${typeof value}>`;
      if (Array.isArray(value)) return value.map((v) => shape(v, null, uid));
      if (value !== null && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return Object.fromEntries(Object.keys(record).sort().map((k) => [k, shape(record[k], k, uid)]));
      }
      return value;
    };
    const withoutIssuer = (claims: Record<string, unknown>): Record<string, unknown> => {
      const { aud: _aud, iss: _iss, ...rest } = claims;
      return rest;
    };
    const armOf = async (user: User, force: boolean): Promise<Arm> => {
      const result = await user.getIdTokenResult(force);
      return { signInProvider: result.signInProvider!, claims: withoutIssuer(shape(result.claims, null, user.uid) as Record<string, unknown>) };
    };
    const expected = (arm: Arm): Arm => ({ signInProvider: arm.signInProvider, claims: withoutIssuer(arm.claims) });

    const anon = await signInAnonymously(freshAuth());
    expect(await armOf(anon.user, false)).toEqual(expected(obs.anonymous));

    const pwAuth = freshAuth();
    const pw = await createUserWithEmailAndPassword(pwAuth, email, 'pw123456');
    expect(await armOf(pw.user, false)).toEqual(expected(obs.passwordUnverified));
    await updateProfile(pw.user, { displayName, photoURL });
    expect(await armOf(pw.user, true)).toEqual(expected(obs.passwordWithProfile));

    // The sandbox user-admin surface sets a phone number at creation only, so
    // the verified-with-phone arm starts from a record that already has every field.
    const fullAuth = freshAuth();
    authSandbox.createUser(fullAuth, { email, password: 'pw123456', displayName, photoUrl: photoURL, phoneNumber, emailVerified: true });
    const full = await signInWithEmailAndPassword(fullAuth, email, 'pw123456');
    expect(await armOf(full.user, false)).toEqual(expected(obs.passwordVerifiedWithPhone));

    const overlapAuth = freshAuth();
    const overlap = await createUserWithEmailAndPassword(overlapAuth, email, 'pw123456');
    authSandbox.updateUser(overlapAuth, overlap.user.uid, {
      customClaims: { email_verified: true, email: 'custom@oracle.test', name: 'custom-name' },
    });
    expect(await armOf(overlap.user, true)).toEqual(expected(obs.customClaimsOverlappingStandard));

    const fullOverlapAuth = freshAuth();
    authSandbox.createUser(fullOverlapAuth, {
      email, password: 'pw123456', displayName, photoUrl: photoURL, phoneNumber,
      customClaims: {
        email: 'custom@oracle.test', email_verified: true, name: 'custom-name', picture: 'custom-picture',
        phone_number: 'custom-phone', user_id: 'custom-user-id', provider_id: 'custom-provider',
      },
    });
    const fullOverlap = await signInWithEmailAndPassword(fullOverlapAuth, email, 'pw123456');
    expect(await armOf(fullOverlap.user, false)).toEqual(expected(obs.customClaimsOverlappingFullProfile));

    const anonOverlapAuth = freshAuth();
    const anonOverlap = await signInAnonymously(anonOverlapAuth);
    authSandbox.updateUser(anonOverlapAuth, anonOverlap.user.uid, {
      customClaims: { provider_id: 'custom-provider', user_id: 'custom-user-id' },
    });
    expect(await armOf(anonOverlap.user, true)).toEqual(expected(obs.customClaimsOverlappingAnonymous));

    const reserved = obs.reservedClaims as unknown as Record<'single' | 'multiple', { code: string; message: string }>;
    const reservedOutcome = (claims: Record<string, unknown>): { code: string; message: string } | null => {
      try {
        authSandbox.updateUser(anonOverlapAuth, anonOverlap.user.uid, { customClaims: claims });
        return null;
      } catch (e) {
        const err = e as { code: string; message: string };
        return { code: err.code, message: err.message };
      }
    };
    expect(reservedOutcome({ sub: 'x' })).toEqual(reserved.single);
    // The Admin SDK lists the names in its own reserved-list order.
    expect(reservedOutcome({ firebase: {}, iat: 1 })).toEqual(reserved.multiple);

    const customAuth = freshAuth();
    const custom = await signInWithCustomToken(customAuth, JSON.stringify({ uid: 'claims-custom', claims: { role: 'oracle' } }));
    expect(await armOf(custom.user, false)).toEqual(expected(obs.customTokenNewUid));

    const existing = await signInWithCustomToken(fullAuth, JSON.stringify({ uid: full.user.uid }));
    expect(await armOf(existing.user, false)).toEqual(expected(obs.customTokenExistingEmailAccount));
  });

  // ── completeness: every observation is asserted or explicitly N/A ─────

  it('every auth observation is covered (no silent gaps)', () => {
    const r = obsGate.report();
    expect(r.committed.length).toBeGreaterThanOrEqual(26);
    expect(r.loadedButUnused).toEqual([]); // a bare load() with no field read fails
    expect(r.uncovered).toEqual([]); // every capture is asserted or explicitly N/A
  });
});
