/** Set the identity every later call runs under. */
import { z } from 'zod';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  mode: z
    .enum(['admin', 'uid', 'anonymous', 'app-session'])
    .describe('admin bypasses rules, uid enforces them as that user, anonymous is unauthenticated.'),
  uid: z.string().optional().describe("The user to act as when mode is 'uid'."),
  tenant: z
    .string()
    .optional()
    .describe('Identity Platform tenant, projected into request.auth.token.firebase.tenant.'),
  claims: z
    .record(z.unknown())
    .optional()
    .describe('Custom claims for this identity, read as request.auth.token.<name>.'),
});

export default {
  verb: 'switch',
  service: 'auth',
  object: 'identity',
  description:
    'Set the caller identity every later call runs under. The tenant and claims are projected into the auth token rules evaluate.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    const held = ctx.identity.switchTo(input);
    return {
      ok: true,
      summary: held.uid ? `Acting as ${held.uid}` : `Acting as ${held.mode}`,
      data: { identity: held },
    };
  },
} satisfies OperationRecord;
