import type { AuthCredential } from 'pyric/auth';
import type { SerializedUser, SerializedUserCredential } from '../protocol.js';
import { credentialWireOf } from './auth-credential-wire.js';
import { requireUserPort, type ClientUser, type ClientUserCredential } from './auth.js';
import { syncClientUserFromWire } from './auth-user-identity.js';
import { nextId, rpc } from './core.js';

export async function linkWithCredential(user: ClientUser, credential: AuthCredential): Promise<ClientUserCredential> {
  const port = requireUserPort(user, 'linkWithCredential');
  const raw = await rpc(port, {
    t: 'op', id: nextId(), method: 'auth.linkWithCredential', uid: user.uid, tenantId: user.tenantId,
    credential: credentialWireOf(credential),
  }) as SerializedUserCredential;
  syncClientUserFromWire(port, user, raw.user);
  return {
    user,
    providerId: raw.providerId,
    operationType: raw.operationType,
    _additionalUserInfo: raw.additionalUserInfo,
  };
}

export async function unlink(user: ClientUser, providerId: string): Promise<ClientUser> {
  const port = requireUserPort(user, 'unlink');
  const raw = await rpc(port, {
    t: 'op', id: nextId(), method: 'auth.unlink', uid: user.uid, tenantId: user.tenantId, providerId,
  }) as SerializedUser;
  syncClientUserFromWire(port, user, raw);
  return user;
}
