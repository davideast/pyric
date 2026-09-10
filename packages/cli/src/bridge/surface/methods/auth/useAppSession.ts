/**
 * Adopt the app's own signed-in user as the identity every later call runs as.
 *
 * This is the one method that crosses between the two identities. The app
 * session carries the tenant it signed in under and the claims on its record,
 * so adopting it projects both into `request.auth.token` and rules evaluate
 * the agent's calls exactly as they evaluate the application's.
 *
 * An app that is signed out has no user to adopt, so the identity falls back
 * to the app session mode the surface starts in, and the summary says so.
 */
import { z } from 'zod';
import { readAppSession } from '../../app-session.js';
import { switchHeldIdentity } from '../../held-identity.js';
import { impersonatedIdentity, type NamedIdentity } from '../../stored-identity.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'auth',
  method: 'useAppSession',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'useAppSession()',
  description: "Run every later call as the app's own signed-in user.",
  args: z.object({}),
  operation: 'switch_auth_identity',
  example: {},
  async handler(_args, ctx) {
    const session = readAppSession(ctx.sandbox);
    if (session === null) return switchHeldIdentity(ctx, { mode: 'app-session' });
    const named: NamedIdentity = { claims: session.customClaims };
    if (session.tenantId !== null) named.tenant = session.tenantId;
    return switchHeldIdentity(ctx, impersonatedIdentity(ctx, session.uid, named));
  },
} satisfies MethodRecord;
