/** Replace the complete custom claims map on one user. */
import { z } from 'zod';
import { RENAMES, uid } from '../../arguments/auth.js';
import { callSandboxTool } from '../../context.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'auth',
  method: 'setCustomUserClaims',
  sdkOrigin: 'firebase-admin',
  effect: 'write',
  signature: 'setCustomUserClaims(uid, customClaims)',
  description: 'Replace the complete custom claims map on one user.',
  args: z.object({
    uid,
    customClaims: z
      .record(z.unknown())
      .describe('The complete claims map. An empty object clears it.'),
  }),
  operation: 'set_auth_claims',
  renames: RENAMES,
  example: { uid: 'alice', customClaims: { role: 'admin' } },
  async handler(args, ctx) {
    const user = String(args.uid);
    const claims = args.customClaims as Record<string, unknown>;
    const result = await callSandboxTool(ctx, 'auth_set_claims', { uid: user, claims });
    if (!result.ok) return result;
    const known = ctx.identity.projectionFor(user);
    ctx.identity.remember(user, known.tenant, claims);
    return result;
  },
} satisfies MethodRecord;
