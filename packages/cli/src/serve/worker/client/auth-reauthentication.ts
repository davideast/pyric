import type { AuthCredential } from 'pyric/auth';
import type { SerializedUserCredential } from '../protocol.js';
import { requireUserPort, type ClientUser, type ClientUserCredential } from './auth.js';
import { nextId, rpc } from './core.js';

export async function reauthenticateWithCredential(user: ClientUser, credential: AuthCredential): Promise<ClientUserCredential> {
  const port = requireUserPort(user, 'reauthenticateWithCredential');
  const raw = await rpc(port, {
    t: 'op', id: nextId(), method: 'auth.reauthenticateWithCredential', uid: user.uid, tenantId: user.tenantId,
    credential: { ...credential.toJSON(), providerId: credential.providerId, signInMethod: credential.signInMethod },
  }) as SerializedUserCredential;
  Object.assign(user, raw.user);
  return { ...raw, user };
}

export async function reauthenticateWithProvider(
  user: ClientUser,
  identity: { uid: string; providerId: string },
): Promise<ClientUserCredential> {
  const port = requireUserPort(user, 'reauthenticateWithProvider');
  const raw = await rpc(port, {
    t: 'op', id: nextId(), method: 'auth.reauthenticateWithProvider', uid: user.uid, tenantId: user.tenantId, identity,
  }) as SerializedUserCredential;
  Object.assign(user, raw.user);
  return { ...raw, user };
}
