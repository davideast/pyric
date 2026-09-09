/**
 * SharedWorker client — Admin user-DB and provider-config functions extracted
 * from `client/auth.ts` to keep modules well under `< 600` lines (`docs/code-conventions.md`).
 */

import type { AuthUserRecord, CreateUserRequest, UpdateUserRequest } from 'pyric/auth';
import { nextId, rpc } from './core.js';
import type { ClientAuth } from './auth.js';

// ─── Admin user-DB ops (Pyric Studio data browse) ─────────────────────────
// Mirror `pyric/auth`'s `sandbox.{listUsers,createUser,updateUser,deleteUser,
// clearUsers}` over the port. No lens (admin control surface), so bare `rpc`.

export async function listUsers(auth: ClientAuth): Promise<AuthUserRecord[]> {
  return (await rpc(auth.port, {
    t: 'op', id: nextId(), method: 'auth.listUsers',
  })) as AuthUserRecord[];
}

export async function adminCreateUser(
  auth: ClientAuth,
  request: CreateUserRequest,
): Promise<AuthUserRecord> {
  return (await rpc(auth.port, {
    t: 'op', id: nextId(), method: 'auth.adminCreateUser',
    request: request as unknown as Record<string, unknown>,
  })) as AuthUserRecord;
}

export async function adminUpdateUser(
  auth: ClientAuth,
  uid: string,
  request: UpdateUserRequest,
): Promise<AuthUserRecord> {
  return (await rpc(auth.port, {
    t: 'op', id: nextId(), method: 'auth.adminUpdateUser', uid,
    request: request as unknown as Record<string, unknown>,
  })) as AuthUserRecord;
}

export async function adminDeleteUser(auth: ClientAuth, uid: string): Promise<void> {
  await rpc(auth.port, { t: 'op', id: nextId(), method: 'auth.adminDeleteUser', uid });
}

export async function adminClearUsers(auth: ClientAuth): Promise<void> {
  await rpc(auth.port, { t: 'op', id: nextId(), method: 'auth.adminClearUsers' });
}

// ─── Sign-in provider config (Pyric Studio S-AUTH) ────────────────────────
// Mirror `pyric/auth`'s `sandbox.{getAuthProviderConfig,setAuthProviderConfig}`
// over the port. No dedicated subscription: `setProviderConfig` fires a
// `provider_config_update` sandbox event, so a caller re-reads via
// `getProviderConfig` on the SAME event feed `listUsers` callers already
// subscribe to (see `worker-live.ts`'s `subscribeUsers`).

export async function getProviderConfig(
  auth: ClientAuth,
): Promise<Array<{ providerId: string; enabled: boolean }>> {
  return (await rpc(auth.port, {
    t: 'op', id: nextId(), method: 'auth.getProviderConfig',
  })) as Array<{ providerId: string; enabled: boolean }>;
}

export async function setProviderConfig(
  auth: ClientAuth,
  providerId: string,
  enabled: boolean,
): Promise<void> {
  await rpc(auth.port, {
    t: 'op', id: nextId(), method: 'auth.setProviderConfig', providerId, enabled,
  });
}
