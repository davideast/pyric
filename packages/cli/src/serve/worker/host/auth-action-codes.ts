import { applyActionCode, checkActionCode, confirmPasswordReset, sendEmailVerification,
  sendPasswordResetEmail, sendSignInLinkToEmail, sandbox, verifyBeforeUpdateEmail, verifyPasswordResetCode } from 'pyric/auth';
import { resolveEmailLinkIdentity } from 'pyric/auth/internal';
import type { OpMessage } from '../protocol.js';
import { ensureAuth, portSession, setPortSession } from '../host-auth.js';
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
        const { user, isNewUser } = resolveEmailLinkIdentity(auth, message.email, message.link);
        const session = sandbox.mintSession(auth, { kind: 'provider', uid: user.uid,
          providerId: 'password', tenantId: message.tenantId ?? null });
        await bestEffortFlush(ctx, message.method);
        setPortSession(ctx, port, session);
        ok(port, message.id, credReply(session, null, isNewUser));
        return;
      }
      case 'auth.sendPasswordResetEmail':
        await sendPasswordResetEmail(auth, message.email, message.settings);
        break;
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
