import { FirebaseError } from 'pyric/app';
import { AuthCredential, linkWithCredential, unlink, sandbox, type Auth, type MintedSession } from 'pyric/auth';
import type { OpMessage } from '../protocol.js';
import { requirePortSession } from './auth-session-seeder.js';

type LinkingOperation = Extract<OpMessage, { method: 'auth.linkWithCredential' | 'auth.unlink' }>;

/** Apply the engine's linking policy to this connection's authenticated user. */
export async function linkSessionProvider(
  auth: Auth,
  current: MintedSession | null,
  message: LinkingOperation,
): Promise<MintedSession> {
  const session = requirePortSession(current, message.method);
  const sameUser = session.user.uid === message.uid && session.user.tenantId === message.tenantId;
  const isStaleUser = !sameUser;
  if (isStaleUser) throw new FirebaseError('auth/user-mismatch', 'The user no longer owns this connection’s session.');
  const isLink = message.method === 'auth.linkWithCredential';
  if (isLink) {
    const credential = AuthCredential.fromJSON(message.credential);
    const isInvalid = credential === null;
    if (isInvalid) throw new FirebaseError('auth/invalid-credential', 'The linking credential is invalid.');
    await linkWithCredential(session.user, credential);
    return sandbox.mintSession(auth, {
      kind: 'provider', uid: message.uid, tenantId: message.tenantId, providerId: credential.providerId,
    });
  }
  await unlink(session.user, message.providerId);
  return sandbox.mintSession(auth, { kind: 'uid', uid: message.uid, tenantId: message.tenantId });
}
