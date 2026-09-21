import { FirebaseError } from 'pyric/app';
import { AuthCredential, OAuthProvider, reauthenticateWithCredential, reauthenticateWithPopup,
  type MintedSession, type UserCredential } from 'pyric/auth';
import type { OpMessage } from '../protocol.js';
import { requireMatchingPortSession } from './auth-session-seeder.js';

type ReauthenticationOperation = Extract<OpMessage, {
  method: 'auth.reauthenticateWithCredential' | 'auth.reauthenticateWithProvider';
}>;

/** Reuse engine verification without creating a new sign-in or persisted account mutation. */
export async function reauthenticateSession(current: MintedSession | null, message: ReauthenticationOperation) {
  const original = requireMatchingPortSession(current, message);
  const isCredential = message.method === 'auth.reauthenticateWithCredential';
  let result: UserCredential;
  if (isCredential) {
    const credential = AuthCredential.fromJSON(message.credential);
    const isInvalid = credential === null;
    if (isInvalid) throw new FirebaseError('auth/invalid-credential', 'The reauthentication credential is invalid.');
    result = await reauthenticateWithCredential(original.user, credential);
  } else {
    const identity = message.identity;
    // The page resolves the provider identity; the engine verifies that its UID matches.
    const resolve = async (): Promise<UserCredential> => ({
      user: { ...original.user, uid: identity.uid },
      providerId: identity.providerId,
      operationType: 'reauthenticate',
    });
    result = await reauthenticateWithPopup(original.user, new OAuthProvider(identity.providerId), {
      openPopup: resolve, openRedirect: resolve,
    });
  }
  const user = Object.assign(result.user, { tenantId: original.user.tenantId });
  const token = await user.getIdTokenResult();
  const session: MintedSession = { user, state: { ...original.state, token: { ...token.claims } } };
  return { session, providerId: result.providerId };
}
