/** Replace one user's custom claims. */
import { z } from 'zod';
import { callSandboxTool } from '../context.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  uid: z.string().describe('The user to change.'),
  claims: z
    .record(z.unknown())
    .describe('The complete claims map. Rules read it as request.auth.token.<name>. An empty object clears it.'),
});

export default {
  verb: 'set',
  service: 'auth',
  object: 'claims',
  description: "Replace one user's custom claims. Rules read them as request.auth.token.<name>.",
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    const result = await callSandboxTool(ctx, 'auth_set_claims', {
      uid: input.uid,
      claims: input.claims,
    });
    if (!result.ok) return result;
    const known = ctx.identity.projectionFor(input.uid);
    ctx.identity.remember(input.uid, known.tenant, input.claims);
    return result;
  },
} satisfies OperationRecord;
