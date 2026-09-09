/** Seed one user in the sandbox auth pool, with its tenant and claims. */
import { z } from 'zod';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import type { LocalSandbox } from 'pyric/sandbox';
import { callSandboxTool } from '../context.js';
import type { OperationRecord } from '../types.js';

interface TenantSeedInput {
  tenant: string;
  email?: string;
  password?: string;
  displayName?: string;
  claims?: Record<string, unknown>;
}

/**
 * Store the tenant on the created record. The create tool carries no tenant
 * and the update path does not either; `seedUsers` is the one seam that writes
 * `tenantId`, and it overwrites an existing uid by design, so the record is
 * re-seeded with the tenant attached. The exported record supplies every field
 * the create already set. A record without an email is not exportable, so it
 * is seeded with a sandbox-local address and password instead.
 */
function persistTenant(sandbox: LocalSandbox, uid: string, input: TenantSeedInput): void {
  const auth = getAuth(sandbox);
  const exported = authSandbox.exportUsers(auth).find((user) => user.uid === uid);
  if (exported !== undefined) {
    authSandbox.seedUsers(auth, [{ ...exported, tenantId: input.tenant }]);
    return;
  }
  const seed: {
    uid: string;
    email: string;
    password: string;
    tenantId: string;
    displayName?: string;
    customClaims?: Record<string, unknown>;
  } = {
    uid,
    email: input.email ?? `${uid}@sandbox.invalid`,
    password: input.password ?? `sandbox-${uid}`,
    tenantId: input.tenant,
  };
  if (input.displayName !== undefined) seed.displayName = input.displayName;
  if (input.claims !== undefined) seed.customClaims = input.claims;
  authSandbox.seedUsers(auth, [seed]);
}

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

    if (input.tenant !== undefined) {
      persistTenant(ctx.sandbox, uid, { ...input, tenant: input.tenant });
    }

    const projected = ctx.identity.remember(uid, input.tenant, input.claims);
    return {
      ok: true,
      summary: result.summary,
      data: { ...(result.data as Record<string, unknown>), identity: projected },
    };
  },
} satisfies OperationRecord;
