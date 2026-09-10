/**
 * The app session: the user the sandbox's own SDK is signed in as.
 *
 * Two identities live in one sandbox and the surface exists to keep them
 * apart. The agent identity is what the agent's own calls run under, and the
 * identity methods set it. The app session is what an application built on the
 * SDK sees from `onAuthStateChanged`, and the sign-in methods set it.
 *
 * A headless server has no browser, so there is no second representation to
 * look for: the app session is `getAuth(sandbox).currentUser` on the sandbox's
 * default Auth handle, which is the same handle a served page's SDK writes
 * through. `signInWithEmailAndPassword` moves it and leaves the agent identity
 * where it was; `useAppSession` is the one method that copies it onto the
 * agent identity.
 *
 * The stored record supplies what the `User` handle does not carry: the custom
 * claims rules read, and the tenant when a session was restored rather than
 * signed in. The provider comes from the sandbox's own record of what this
 * sign-in presented, which is what `IdTokenResult.signInProvider` reports.
 */
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import type { LocalSandbox } from 'pyric/sandbox';
import type { Auth, AuthUserRecord, User } from 'pyric/auth';

/** The app's own signed-in user, as every method that reports one spells it. */
export interface AppSession {
  uid: string;
  email: string | null;
  isAnonymous: boolean;
  /** The provider this sign-in presented: `password`, `anonymous`, `custom`, or a provider id. */
  providerId: string;
  /** Identity Platform tenant, or null for the project-level pool. */
  tenantId: string | null;
  /** Custom claims, as rules read them under `request.auth.token`. */
  customClaims: Record<string, unknown>;
}

/**
 * The provider that labels a session: the one this sign-in presented, not the
 * first provider ever linked to the record.
 *
 * The sandbox already records it at sign-in time, and it is what
 * `IdTokenResult.signInProvider` and the `firebase.sign_in_provider` claim
 * carry, so this reads that rather than keeping a second copy. Reading the
 * record's linked providers instead would report `password` for a federated
 * credential presented for an address that already had a password account, and
 * for a custom token, which Firebase labels `custom`.
 *
 * A session the test driver put in place records no provider. An anonymous
 * user is `anonymous`, and anything else falls back to `password`, which is
 * the only provider a record can hold without a sign-in having happened.
 */
function providerOf(auth: Auth, user: User): string {
  const signedInThrough = authSandbox.signInProvider(auth);
  if (signedInThrough !== null) return signedInThrough;
  if (user.isAnonymous) return 'anonymous';
  return 'password';
}

/** The tenant a session authenticated under, from the handle or the record. */
function tenantOf(user: User, record: AuthUserRecord | undefined): string | null {
  if (typeof user.tenantId === 'string') return user.tenantId;
  return record?.tenantId ?? null;
}

/** The app's signed-in user, or null when the app is signed out. */
export function readAppSession(sandbox: LocalSandbox): AppSession | null {
  const auth = getAuth(sandbox);
  const user = auth.currentUser;
  if (user === null) return null;
  const record = authSandbox.listUsers(auth).find((entry) => entry.uid === user.uid);
  return {
    uid: user.uid,
    email: user.email,
    isAnonymous: user.isAnonymous,
    providerId: providerOf(auth, user),
    tenantId: tenantOf(user, record),
    customClaims: record?.customClaims ?? {},
  };
}

/** One line naming the app session, for the summary every reporter writes. */
export function describeAppSession(session: AppSession | null): string {
  if (session === null) return 'signed out';
  const parts = [session.uid];
  if (session.tenantId !== null) parts.push(`tenant ${session.tenantId}`);
  parts.push(`via ${session.providerId}`);
  return parts.join(', ');
}
