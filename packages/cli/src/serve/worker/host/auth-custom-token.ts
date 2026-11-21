import { sandbox, type User } from 'pyric/auth';
import {
  hasBeforeCreateHook,
  resolveBlockedCustomTokenIdentity,
  resolveCustomTokenIdentity,
} from 'pyric/auth/internal';
import type { OpMessage } from '../protocol.js';
import { ensureAuth, portOriginScope, resolveSignInTenant, setPortSession } from '../host-auth.js';
import { bestEffortFlush, fail, ok, type HostCtx, type PortLike } from '../host-context.js';
import { credReply } from './auth-session-seeder.js';

export async function handleCustomTokenSignIn(
  ctx: HostCtx,
  port: PortLike,
  message: Extract<OpMessage, { method: 'auth.signInWithCustomToken' }>,
): Promise<void> {
  try {
    const auth = ensureAuth(ctx);
    const tenantId = resolveSignInTenant(ctx, port, message.tenantId);
    let resolved: { user: User; isNewUser: boolean };
    if (hasBeforeCreateHook(auth)) {
      resolved = await resolveBlockedCustomTokenIdentity(auth, message.customToken, tenantId);
    } else {
      resolved = resolveCustomTokenIdentity(auth, message.customToken, tenantId);
    }
    const { user, isNewUser } = resolved;
    const session = sandbox.mintSession(auth, {
      kind: 'custom', uid: user.uid, tenantId, ...portOriginScope(port),
    });
    await bestEffortFlush(ctx, message.method);
    setPortSession(ctx, port, session);
    ok(port, message.id, credReply(session, null, isNewUser));
  } catch (error) { fail(port, message.id, error); }
}
