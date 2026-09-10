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
import { impersonatedIdentity, type NamedIdentity } from '../../stored-identity.js';
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
    const named: NamedIdentity = {};
    if (args.tenantId !== undefined) named.tenant = String(args.tenantId);
    if (args.customClaims !== undefined) {
      named.claims = args.customClaims as Record<string, unknown>;
    }
    return switchHeldIdentity(ctx, impersonatedIdentity(ctx, String(args.uid), named));
  },
} satisfies MethodRecord;
