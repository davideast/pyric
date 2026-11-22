import type { AuthCredential } from 'pyric/auth';
import type { SerializedUserCredential } from '../protocol.js';
import { credentialWireOf } from './auth-credential-wire.js';
import { requireUserPort, type ClientUser, type ClientUserCredential } from './auth.js';
import { attachHeldUserIdentity, syncClientUserFromWire } from './auth-user-identity.js';
import { nextId, rpc } from './core.js';

export async function reauthenticateWithCredential(user: ClientUser, credential: AuthCredential): Promise<ClientUserCredential> {
  const port = requireUserPort(user, 'reauthenticateWithCredential');
  const raw = await rpc(port, attachHeldUserIdentity(user, {
    t: 'op', id: nextId(), method: 'auth.reauthenticateWithCredential', uid: user.uid, tenantId: user.tenantId,
    credential: credentialWireOf(credential),
  })) as SerializedUserCredential;
  syncClientUserFromWire(port, user, raw.user);
  return {
    user,
    providerId: raw.providerId,
    operationType: raw.operationType,
    _additionalUserInfo: raw.additionalUserInfo,
  };
}

export async function reauthenticateWithProvider(
  user: ClientUser,
  identity: { uid: string; providerId: string },
): Promise<ClientUserCredential> {
  const port = requireUserPort(user, 'reauthenticateWithProvider');
  const raw = await rpc(port, attachHeldUserIdentity(user, {
    t: 'op', id: nextId(), method: 'auth.reauthenticateWithProvider', uid: user.uid, tenantId: user.tenantId, identity,
  })) as SerializedUserCredential;
  syncClientUserFromWire(port, user, raw.user);
  return {
    user,
    providerId: raw.providerId,
    operationType: raw.operationType,
    _additionalUserInfo: raw.additionalUserInfo,
  };
}
