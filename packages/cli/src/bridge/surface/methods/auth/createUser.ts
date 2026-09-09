/**
 * Create one user in the sandbox auth pool, with its tenant and claims.
 *
 * The create tool carries no tenant and the update path does not either;
 * `seedUsers` is the one seam that writes `tenantId`, so a create that names a
 * tenant re-seeds the record it just made with the tenant attached.
 */
import { z } from 'zod';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import type { LocalSandbox } from 'pyric/sandbox';
import {
  checkCredentials,
  customClaims,
  RENAMES,
  tenantId,
} from '../../arguments/auth.js';
import { callSandboxTool } from '../../context.js';
import type { Args, MethodRecord } from '../../method-types.js';

interface TenantSeedInput {
  tenant: string;
  email?: string;
  password?: string;
  displayName?: string;
  claims?: Record<string, unknown>;
}

/**
 * Store the tenant on the created record. The exported record supplies every
 * field the create already set; a record without an email is not exportable,
 * so it is seeded with a sandbox-local address and password instead.
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

/** The tenant seed one call describes, in the shape `persistTenant` reads. */
function tenantSeed(args: Args, tenant: string): TenantSeedInput {
  const seed: TenantSeedInput = { tenant };
  if (args.email !== undefined) seed.email = String(args.email);
  if (args.password !== undefined) seed.password = String(args.password);
  if (args.displayName !== undefined) seed.displayName = String(args.displayName);
  if (args.customClaims !== undefined) {
    seed.claims = args.customClaims as Record<string, unknown>;
  }
  return seed;
}

export default {
  tool: 'auth',
  method: 'createUser',
  sdkOrigin: 'firebase-admin',
  effect: 'write',
  signature: 'createUser(uid?, email?, password?, displayName?, customClaims?, tenantId?)',
  description: 'Seed a user in the sandbox user pool.',
  args: z.object({
    uid: z.string().optional().describe('User id. Generated when omitted.'),
    email: z.string().optional().describe('Email address.'),
    password: z.string().optional().describe('At least six characters. Never returned.'),
    displayName: z.string().optional().describe('Display name.'),
    customClaims,
    tenantId,
  }),
  operation: 'create_auth_user',
  renames: RENAMES,
  example: {
    uid: 'alice',
    email: 'alice@example.com',
    customClaims: { role: 'owner' },
    tenantId: 'tenant-a',
  },
  validate: (args, { fail }) => checkCredentials(args, fail),
  async handler(args, ctx) {
    const call: Args = {};
    for (const name of ['uid', 'email', 'password', 'displayName']) {
      if (args[name] !== undefined) call[name] = args[name];
    }
    if (args.customClaims !== undefined) call.claims = args.customClaims;

    const result = await callSandboxTool(ctx, 'auth_create_user', call);
    if (!result.ok) return result;

    const created = result.data as { user?: { uid?: string } } | undefined;
    const uid = created?.user?.uid ?? (args.uid as string | undefined);
    if (uid === undefined) return result;

    const tenant = args.tenantId as string | undefined;
    if (tenant !== undefined) persistTenant(ctx.sandbox, uid, tenantSeed(args, tenant));

    const claims = args.customClaims as Record<string, unknown> | undefined;
    const projected = ctx.identity.remember(uid, tenant, claims);
    return {
      ok: true,
      summary: result.summary,
      data: { ...(result.data as Record<string, unknown>), identity: projected },
    };
  },
} satisfies MethodRecord;
