/**
 * Per-port Auth session tenant alignment and email-update session refresh.
 *
 * A signed-in session's tenant belongs strictly to the account it authenticated
 * under (`session.user.tenantId ?? null`), never to client-mutable `auth.tenantId`
 * (`portTenant`). Reassigning `auth.tenantId` only scopes subsequent sign-ins.
 */
import {
  sandbox as authSandboxOps,
  updateEmail,
  type Auth,
  type MintedSession,
} from 'pyric/auth';
import { remintSessionWithClaims } from './auth-session-seeder.js';

/**
 * Synchronize `session.state.tenant`, `session.user.tenantId`, and
 * `session.state.token.firebase.tenant` strictly from the session's own account
 * tenant, never falling back to a port's mutable `auth.tenantId`.
 */
export function alignSessionTenant(session: MintedSession): void {
  const tenant = session.user.tenantId ?? null;
  session.state.tenant = tenant ?? undefined;
  (session.user as { tenantId?: string | null }).tenantId = tenant;
  const token = session.state.token;
  if (!token) return;
  const rawFirebase = token.firebase;
  const hasFirebaseRecord = typeof rawFirebase === 'object' && rawFirebase !== null;
  if (tenant !== null) {
    const baseFirebase = hasFirebaseRecord ? (rawFirebase as Record<string, unknown>) : {};
    session.state.token = { ...token, firebase: { ...baseFirebase, tenant } };
    return;
  }
  if (hasFirebaseRecord && Object.hasOwn(rawFirebase, 'tenant')) {
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawFirebase as Record<string, unknown>)) {
      if (key !== 'tenant') rest[key] = value;
    }
    session.state.token = { ...token, firebase: rest };
  }
}

function storedEmailFor(auth: Auth, session: MintedSession): string | null {
  const stored = authSandboxOps.listUsers(auth).find((record) => record.uid === session.user.uid);
  return stored ? stored.email : session.user.email;
}

/**
 * Update a port session's email and re-mint the session only when the address
 * actually changed (case-insensitive), keeping same-email calls idempotent.
 */
export async function updatePortSessionEmail(
  auth: Auth,
  session: MintedSession,
  newEmail: string,
): Promise<{ session: MintedSession; changed: boolean }> {
  const previousEmail = storedEmailFor(auth, session);
  await updateEmail(session.user, newEmail);
  const changed = previousEmail === null || previousEmail.toLowerCase() !== newEmail.toLowerCase();
  if (!changed) return { session, changed: false };
  return { session: remintSessionWithClaims(auth, session), changed: true };
}
