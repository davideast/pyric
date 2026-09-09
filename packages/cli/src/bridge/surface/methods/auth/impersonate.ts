/**
 * Run every later call as one user.
 *
 * This and the three `actAs` methods replaced a single `signInAs(mode)`, whose
 * invented enum was the cause of every rejection the surface evaluation
 * measured. The mode each method selects is its own name, not an argument.
 */
import { z } from 'zod';
import { customClaims, RENAMES, tenantId } from '../../arguments/auth.js';
import { switchHeldIdentity } from '../../held-identity.js';
import type { IdentityInput } from '../../identity.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'auth',
  method: 'impersonate',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'impersonate(uid, tenantId?, customClaims?)',
  description: 'Run every later call as this user.',
  args: z.object({
    uid: z.string().describe('The user to act as.'),
    tenantId,
    customClaims,
  }),
  operation: 'switch_auth_identity',
  renames: RENAMES,
  example: { uid: 'alice', tenantId: 'tenant-a' },
  async handler(args, ctx) {
    const input: IdentityInput = { mode: 'uid', uid: String(args.uid) };
    if (args.tenantId !== undefined) input.tenant = String(args.tenantId);
    if (args.customClaims !== undefined) {
      input.claims = args.customClaims as Record<string, unknown>;
    }
    return switchHeldIdentity(ctx, input);
  },
} satisfies MethodRecord;
