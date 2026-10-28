/**
 * Replays the Admin SDK answers in the production capture
 * `auth-request-auth-per-sign-in` (`behavior.admin`) through pyric-admin's
 * in-process arm (`initializeApp({ sandbox })`).
 *
 * Each call's outcome is compared as `resolved`, or the error code with
 * whether it threw synchronously. Every difference must be pinned with both
 * answers and the finding; fixing a finding turns its pin red, and the fix
 * deletes the pin.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { initializeSandbox } from 'pyric/sandbox';
import { createUserWithEmailAndPassword, getAuth as getClientAuth, sandbox as clientSandbox } from 'pyric/auth';
import { deleteApp, getApps, initializeApp } from '../app/index.js';
import { getAuth } from './index.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

type Recorded = { resolved?: true; code?: string | null; threw?: string; rejected?: true };
const OBSERVATION = JSON.parse(readFileSync(new URL('../../../conformance/observations/auth/auth-request-auth-per-sign-in.json', import.meta.url), 'utf8')) as {
  behavior: { admin: Record<string, Recorded> };
};

function summary(r: Recorded): string {
  if (r.resolved) return 'resolved';
  return `${r.threw === 'synchronously' ? 'throws' : 'rejects'} ${r.code ?? '(no code)'}`;
}
async function outcome(run: () => unknown): Promise<string> {
  let promise: unknown;
  try {
    promise = run();
  } catch (e) {
    return `throws ${(e as { code?: string }).code ?? '(no code)'}`;
  }
  try {
    await promise;
    return 'resolved';
  } catch (e) {
    return `rejects ${(e as { code?: string }).code ?? '(no code)'}`;
  }
}

/** Known differences, keyed by the observation's call name. */
const PINS: Record<string, { pyric: string; production: string; finding: string }> = {
  createUserTakenEmail: { pyric: 'resolved', production: 'rejects auth/email-already-exists', finding: 'auth-claims AU-6: admin user-management errors are missing or use client codes' },
  createUserTakenUid: { pyric: 'rejects (no code)', production: 'rejects auth/uid-already-exists', finding: 'auth-claims AU-6' },
  createUserShortPassword: { pyric: 'resolved', production: 'rejects auth/invalid-password', finding: 'auth-claims AU-6' },
  createUserInvalidEmail: { pyric: 'resolved', production: 'rejects auth/invalid-email', finding: 'auth-claims AU-6' },
  getUserMissing: { pyric: 'rejects (no code)', production: 'rejects auth/user-not-found', finding: 'auth-claims AU-6' },
  getUserByEmailMissing: { pyric: 'rejects (no code)', production: 'rejects auth/user-not-found', finding: 'auth-claims AU-6' },
  getUserByEmailOtherCase: { pyric: 'rejects (no code)', production: 'resolved', finding: 'auth-claims CO-4: getUserByEmail matches the stored email case-sensitively' },
  deleteUserMissing: { pyric: 'rejects (no code)', production: 'rejects auth/user-not-found', finding: 'auth-claims AU-6' },
  setCustomUserClaimsMissing: { pyric: 'rejects (no code)', production: 'rejects auth/user-not-found', finding: 'auth-claims AU-6' },
  setCustomUserClaims1100: { pyric: 'resolved', production: 'rejects auth/claims-too-large', finding: 'auth-claims AU-5: no 1000-character custom-claims limit' },
  createCustomTokenEmptyUid: { pyric: 'resolved', production: 'throws auth/argument-error', finding: 'auth-claims AU-4: createCustomToken validates neither uid nor claims' },
  createCustomToken129Uid: { pyric: 'resolved', production: 'throws auth/argument-error', finding: 'auth-claims AU-4' },
  createCustomTokenReservedAud: { pyric: 'resolved', production: 'throws auth/argument-error', finding: 'auth-claims AU-4' },
  createCustomTokenNullClaims: { pyric: 'resolved', production: 'throws auth/argument-error', finding: 'auth-claims AU-4' },
  verifyIdTokenOfCustomToken: { pyric: 'resolved', production: 'rejects auth/argument-error', finding: 'auth-claims AU-9: verifyIdToken accepts a custom token' },
  verifyIdTokenCheckRevokedDisabled: { pyric: 'resolved', production: 'rejects auth/user-disabled', finding: 'auth-claims AU-10: checkRevoked ignores disabled and deleted users' },
  verifyIdTokenCheckRevokedDeleted: { pyric: 'resolved', production: 'rejects auth/user-not-found', finding: 'auth-claims AU-10' },
};

describe('pyric-admin auth answers as the production Admin SDK does', () => {
  it('user management, custom tokens, custom claims and verifyIdToken', async () => {
    const sandbox = initializeSandbox();
    const admin = getAuth(initializeApp({ sandbox }, 'oracle-admin-answers'));
    const email = 'ad@example.com';
    const uid = 'oracle-ad';
    await admin.createUser({ uid, email, password: 'secret-pw' });

    // A client session on the same sandbox, for verifyIdToken.
    const client = getClientAuth(sandbox);
    const { user } = await createUserWithEmailAndPassword(client, 'verify@example.com', 'secret-pw');
    const idToken = await user.getIdToken();

    const observed: Record<string, string> = {
      createUserTakenEmail: await outcome(() => admin.createUser({ email, password: 'secret-pw' })),
      createUserTakenUid: await outcome(() => admin.createUser({ uid, password: 'secret-pw' })),
      createUserShortPassword: await outcome(() => admin.createUser({ uid: 'oracle-short', password: '12345' })),
      createUserInvalidEmail: await outcome(() => admin.createUser({ uid: 'oracle-bad', email: 'nope' })),
      getUserMissing: await outcome(() => admin.getUser('oracle-missing')),
      getUserByEmailMissing: await outcome(() => admin.getUserByEmail('oracle-missing@example.com')),
      getUserByEmailOtherCase: await outcome(() => admin.getUserByEmail(email.toUpperCase())),
      deleteUserMissing: await outcome(() => admin.deleteUser('oracle-missing')),
      setCustomUserClaimsMissing: await outcome(() => admin.setCustomUserClaims('oracle-missing', { a: 1 })),
      setCustomUserClaims1100: await outcome(() => admin.setCustomUserClaims(uid, { blob: 'x'.repeat(1100) })),
      setCustomUserClaimsReserved: await outcome(() => admin.setCustomUserClaims(uid, { sub: 'x' })),
      createCustomTokenEmptyUid: await outcome(() => admin.createCustomToken('')),
      createCustomToken129Uid: await outcome(() => admin.createCustomToken('x'.repeat(129))),
      createCustomToken128Uid: await outcome(() => admin.createCustomToken('x'.repeat(128))),
      createCustomTokenReservedAud: await outcome(() => admin.createCustomToken('u', { aud: 'x' })),
      createCustomTokenReservedFirebase: await outcome(() => admin.createCustomToken('u', { firebase: {} })),
      createCustomTokenNullClaims: await outcome(() => admin.createCustomToken('u', null as never)),
      verifyIdTokenOfCustomToken: await outcome(async () => admin.verifyIdToken(await admin.createCustomToken('u'))),
    };
    clientSandbox.updateUser(client, user.uid, { disabled: true });
    observed.verifyIdTokenNoCheckDisabled = await outcome(() => admin.verifyIdToken(idToken));
    observed.verifyIdTokenCheckRevokedDisabled = await outcome(() => admin.verifyIdToken(idToken, true));
    clientSandbox.deleteUser(client, user.uid);
    observed.verifyIdTokenCheckRevokedDeleted = await outcome(() => admin.verifyIdToken(idToken, true));

    const found: Record<string, { pyric: string; production: string }> = {};
    for (const [call, pyric] of Object.entries(observed)) {
      const production = summary(OBSERVATION.behavior.admin[call]);
      if (pyric !== production) found[call] = { pyric, production };
    }
    const pinned = Object.fromEntries(Object.entries(PINS).map(([call, pin]) => [call, { pyric: pin.pyric, production: pin.production }]));
    expect(found).toEqual(pinned);
  });
});
