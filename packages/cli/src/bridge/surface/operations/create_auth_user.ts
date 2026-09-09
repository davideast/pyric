/** Seed one user in the sandbox auth pool, with its tenant and claims. */
import { z } from 'zod';
import { callSandboxTool } from '../context.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  uid: z.string().optional().describe('User id. Generated when omitted.'),
  email: z.string().optional().describe('Email address.'),
  password: z.string().optional().describe('At least six characters. Never returned.'),
  displayName: z.string().optional().describe('Display name.'),
  claims: z
    .record(z.unknown())
    .optional()
    .describe('Custom claims. Rules read them as request.auth.token.<name>.'),
  tenant: z
    .string()
    .optional()
    .describe('Identity Platform tenant. Rules read it as request.auth.token.firebase.tenant.'),
});

export default {
  verb: 'create',
  service: 'auth',
  object: 'user',
  description:
    'Create one user in the sandbox auth pool. Custom claims and the tenant are projected into the auth token rules evaluate.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    const call: Record<string, unknown> = {};
    if (input.uid !== undefined) call.uid = input.uid;
    if (input.email !== undefined) call.email = input.email;
    if (input.password !== undefined) call.password = input.password;
    if (input.displayName !== undefined) call.displayName = input.displayName;
    if (input.claims !== undefined) call.claims = input.claims;

    const result = await callSandboxTool(ctx, 'auth_create_user', call);
    if (!result.ok) return result;

    const created = result.data as { user?: { uid?: string } } | undefined;
    const uid = created?.user?.uid ?? input.uid;
    if (uid === undefined) return result;

    const projected = ctx.identity.remember(uid, input.tenant, input.claims);
    return {
      ok: true,
      summary: result.summary,
      data: { ...(result.data as Record<string, unknown>), identity: projected },
    };
  },
} satisfies OperationRecord;
