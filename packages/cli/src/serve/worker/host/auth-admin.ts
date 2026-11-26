/**
 * SharedWorker host -- Auth admin user-DB, provider-config, and project-setting
 * operations extracted from `host-auth.ts` (`<= 600` lines per file).
 */
import { sandbox as authSandboxOps, type Auth } from 'pyric/auth';
import { authAccountsFor } from 'pyric/sandbox/internal';
import { bestEffortFlush, fail, ok, type HostCtx, type PortLike } from '../host-context.js';
import type { OpMessage } from '../protocol.js';

const adminMethods = [
  'auth.listUsers',
  'auth.adminCreateUser',
  'auth.adminUpdateUser',
  'auth.adminDeleteUser',
  'auth.adminGetAccountStanding',
  'auth.adminRevokeRefreshTokens',
  'auth.adminClearUsers',
  'auth.getProviderConfig',
  'auth.setProviderConfig',
  'auth.getEmailEnumerationProtection',
  'auth.setEmailEnumerationProtection',
] as const;

export type AuthAdminOpMessage = Extract<OpMessage, { method: (typeof adminMethods)[number] }>;
const adminMethodSet: ReadonlySet<string> = new Set(adminMethods);

export function isAuthAdminOp(msg: OpMessage): msg is AuthAdminOpMessage {
  return adminMethodSet.has(msg.method);
}

export async function handleAuthAdminOp(
  ctx: HostCtx,
  port: PortLike,
  auth: Auth,
  msg: AuthAdminOpMessage,
): Promise<void> {
  try {
    switch (msg.method) {
      case 'auth.listUsers': {
        ok(port, msg.id, authSandboxOps.listUsers(auth));
        return;
      }

      case 'auth.adminCreateUser': {
        const created = authSandboxOps.createUser(
          auth,
          msg.request as Parameters<typeof authSandboxOps.createUser>[1],
        );
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, created);
        return;
      }

      case 'auth.adminUpdateUser': {
        const updated = authSandboxOps.updateUser(
          auth,
          msg.uid,
          msg.request as Parameters<typeof authSandboxOps.updateUser>[2],
        );
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, updated);
        return;
      }

      case 'auth.adminDeleteUser': {
        authSandboxOps.deleteUser(auth, msg.uid);
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, null);
        return;
      }

      case 'auth.adminGetAccountStanding': {
        const standing = authAccountsFor(ctx.sandbox)?.standing(msg.uid) ?? { kind: 'unrecorded' };
        ok(port, msg.id, standing);
        return;
      }

      case 'auth.adminRevokeRefreshTokens': {
        const accounts = authAccountsFor(ctx.sandbox);
        const standing = accounts?.standing(msg.uid) ?? { kind: 'unrecorded' };
        const hasRecord = accounts !== undefined && (standing.kind === 'active' || standing.kind === 'disabled');
        if (!hasRecord) {
          throw Object.assign(
            new Error('There is no user record corresponding to the provided identifier.'),
            { code: 'auth/user-not-found' },
          );
        }
        accounts.revokeRefreshTokens(msg.uid);
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, null);
        return;
      }

      case 'auth.adminClearUsers': {
        authSandboxOps.clearUsers(auth);
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, null);
        return;
      }

      case 'auth.getProviderConfig': {
        ok(port, msg.id, authSandboxOps.getAuthProviderConfig(auth));
        return;
      }

      case 'auth.setProviderConfig': {
        authSandboxOps.setAuthProviderConfig(auth, msg.providerId, msg.enabled);
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, null);
        return;
      }

      case 'auth.getEmailEnumerationProtection': {
        ok(port, msg.id, authSandboxOps.getEmailEnumerationProtection(auth));
        return;
      }

      case 'auth.setEmailEnumerationProtection': {
        authSandboxOps.setEmailEnumerationProtection(auth, msg.enabled);
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, null);
        return;
      }
    }
  } catch (err) {
    fail(port, msg.id, err);
  }
}
