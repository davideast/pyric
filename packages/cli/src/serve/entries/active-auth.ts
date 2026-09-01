import * as ipAuth from 'pyric/auth';
import * as wcRaw from '../worker/client.js';
import { acceptProviderCredential, restorePortSession } from '../worker/client.js';
import type { RuntimeIdentity } from '../runtime/identity.js';
import { createActiveAuthRegistry } from './active-auth-registry.js';
import { useWorker } from './worker-runtime.js';

const wc = wcRaw as unknown as typeof ipAuth;
const selectedAuth = useWorker ? wc : ipAuth;
type ActiveAuth = { currentUser: RuntimeIdentity | null };
const observeActiveAuth = selectedAuth.onAuthStateChanged as unknown as (
  auth: ActiveAuth,
  listener: (user: RuntimeIdentity | null) => void,
) => () => void;
const activeAuthRegistry = createActiveAuthRegistry<ActiveAuth>(observeActiveAuth);

export function registerActiveAuth(auth: ActiveAuth): () => void {
  return activeAuthRegistry.register(auth);
}

export function subscribeToActiveAuth(
  listener: (user: RuntimeIdentity | null) => void,
): () => void {
  return activeAuthRegistry.subscribe(listener);
}

export function getActiveAuthUser(): RuntimeIdentity | null {
  for (const auth of activeAuthRegistry.auths()) {
    if (auth.currentUser) {
      return {
        uid: auth.currentUser.uid,
        email: auth.currentUser.email,
        displayName: auth.currentUser.displayName,
      };
    }
  }
  return null;
}

export async function switchAllAuthUsers(uid: string): Promise<void> {
  const promises: Promise<unknown>[] = [];
  for (const auth of activeAuthRegistry.auths()) {
    if (useWorker) {
      promises.push(restorePortSession(auth as never, uid));
    } else {
      try {
        ipAuth.sandbox.restoreSession(auth as never, uid);
      } catch {
        // A stale handle or unavailable identity must not block other handles.
      }
    }
  }
  await Promise.all(promises);
}

export async function signOutAllAuths(): Promise<void> {
  const promises: Promise<unknown>[] = [];
  for (const auth of activeAuthRegistry.auths()) {
    if (useWorker) {
      promises.push(wc.signOut(auth as never));
    } else {
      promises.push(ipAuth.signOut(auth as never));
    }
  }
  await Promise.all(promises);
}

export async function commitCredentialToAllAuths(identity: {
  uid: string;
  email?: string | null;
  displayName?: string | null;
  customClaims?: Record<string, unknown>;
  providerId?: string;
}): Promise<void> {
  const promises: Promise<unknown>[] = [];
  for (const auth of activeAuthRegistry.auths()) {
    if (useWorker) {
      promises.push(acceptProviderCredential(auth as never, {
        uid: identity.uid,
        email: identity.email ?? null,
        displayName: identity.displayName ?? null,
        customClaims: identity.customClaims ?? {},
        providerId: identity.providerId ?? 'password',
      }));
    } else {
      try {
        ipAuth.sandbox.seedUsers(auth as never, [{
          uid: identity.uid,
          email: identity.email ?? '',
          password: 'synthetic-password',
          displayName: identity.displayName ?? undefined,
          customClaims: identity.customClaims ?? {},
          providerId: identity.providerId ?? 'password',
        }]);
      } catch {
        // A stale handle or duplicate seed must not block other handles.
      }
    }
  }
  await Promise.all(promises);
}
