import { sandbox } from 'pyric/auth';
import { resolveCustomTokenIdentity } from 'pyric/auth/internal';
import type { OpMessage } from '../protocol.js';
import { ensureAuth, setPortSession } from '../host-auth.js';
import { bestEffortFlush, fail, ok, type HostCtx, type PortLike } from '../host-context.js';
import { credReply } from './auth-session-seeder.js';

export async function handleCustomTokenSignIn(
  ctx: HostCtx,
  port: PortLike,
  message: Extract<OpMessage, { method: 'auth.signInWithCustomToken' }>,
): Promise<void> {
  try {
    const auth = ensureAuth(ctx);
    const { user, isNewUser } = resolveCustomTokenIdentity(auth, message.customToken);
    const session = sandbox.mintSession(auth, { kind: 'custom', uid: user.uid, tenantId: message.tenantId ?? null });
    await bestEffortFlush(ctx, message.method);
    setPortSession(ctx, port, session);
    ok(port, message.id, credReply(session, null, isNewUser));
  } catch (error) { fail(port, message.id, error); }
}
