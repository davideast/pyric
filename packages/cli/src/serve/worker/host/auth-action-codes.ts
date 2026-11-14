import { applyActionCode, checkActionCode, confirmPasswordReset, sendEmailVerification,
  sendSignInLinkToEmail, sandbox, verifyBeforeUpdateEmail, verifyPasswordResetCode } from 'pyric/auth';
import { resolveEmailLinkIdentity, sendTenantPasswordResetEmail } from 'pyric/auth/internal';
import type { OpMessage } from '../protocol.js';
import { ensureAuth, portOriginScope, portSession, portTenant, resolveSignInTenant, setPortSession } from '../host-auth.js';
import { bestEffortFlush, fail, ok, type HostCtx, type PortLike } from '../host-context.js';
import { credReply, requireMatchingPortSession } from './auth-session-seeder.js';

const methods = [
  'auth.sendPasswordResetEmail', 'auth.sendEmailVerification', 'auth.verifyBeforeUpdateEmail',
  'auth.applyActionCode', 'auth.checkActionCode', 'auth.verifyPasswordResetCode', 'auth.confirmPasswordReset',
  'auth.takeMail', 'auth.sendSignInLinkToEmail', 'auth.signInWithEmailLink',
] as const;
type ActionCodeOperation = Extract<OpMessage, { method: typeof methods[number] }>;
const actionCodeMethods: ReadonlySet<string> = new Set(methods);

export function isAuthActionCodeOp(message: OpMessage): message is ActionCodeOperation {
  return actionCodeMethods.has(message.method);
}

/** Mail and codes stay in the engine's outbox; redeemed account changes are persisted. */
export async function handleAuthActionCodeOp(ctx: HostCtx, port: PortLike, message: ActionCodeOperation): Promise<void> {
  const auth = ensureAuth(ctx);
  try {
    switch (message.method) {
      case 'auth.takeMail':
        ok(port, message.id, sandbox.takeAuthMail(auth, message.email));
        return;
      case 'auth.sendSignInLinkToEmail':
        await sendSignInLinkToEmail(auth, message.email, message.settings);
        break;
      case 'auth.signInWithEmailLink': {
        const tenantId = resolveSignInTenant(ctx, port, message.tenantId);
        const { user, isNewUser } = resolveEmailLinkIdentity(auth, message.email, message.link, tenantId);
        const session = sandbox.mintSession(auth, {
          kind: 'provider',
          uid: user.uid,
          providerId: 'password',
          tenantId,
          ...portOriginScope(port),
        });
        await bestEffortFlush(ctx, message.method);
        setPortSession(ctx, port, session);
        ok(port, message.id, credReply(session, null, isNewUser));
        return;
      }
      case 'auth.sendPasswordResetEmail': {
        let tenantId: string | null;
        if (message.tenantId !== undefined) {
          tenantId = resolveSignInTenant(ctx, port, message.tenantId);
        } else {
          tenantId = portTenant(ctx, port) ?? portSession(ctx, port)?.user.tenantId ?? null;
        }
        await sendTenantPasswordResetEmail(auth, message.email, message.settings, tenantId);
        break;
      }
      case 'auth.sendEmailVerification': {
        const session = requireMatchingPortSession(portSession(ctx, port), message);
        await sendEmailVerification(session.user, message.settings);
        break;
      }
      case 'auth.verifyBeforeUpdateEmail': {
        const session = requireMatchingPortSession(portSession(ctx, port), message);
        await verifyBeforeUpdateEmail(session.user, message.newEmail, message.settings);
        break;
      }
      case 'auth.checkActionCode':
        ok(port, message.id, await checkActionCode(auth, message.code));
        return;
      case 'auth.verifyPasswordResetCode':
        ok(port, message.id, await verifyPasswordResetCode(auth, message.code));
        return;
      case 'auth.applyActionCode':
        await applyActionCode(auth, message.code);
        await bestEffortFlush(ctx, message.method);
        break;
      case 'auth.confirmPasswordReset':
        await confirmPasswordReset(auth, message.code, message.newPassword);
        await bestEffortFlush(ctx, message.method);
        break;
      default: {
        const unsupported: never = message;
        throw new Error(`Unknown action-code operation: ${unsupported}`);
      }
    }
    ok(port, message.id, undefined);
  } catch (error) { fail(port, message.id, error); }
}
