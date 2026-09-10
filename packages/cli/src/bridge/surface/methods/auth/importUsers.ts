/**
 * Load many user records into the pool in one call.
 *
 * The entry is `sandbox.seed`'s users entry, not a second shape: an import and
 * a seed describe an identity one way, and both reach the pool through the one
 * seeding function that carries a tenant onto a stored record.
 */
import { z } from 'zod';
import { checkUserFields, userSeed } from '../../arguments/sandbox.js';
import { operationFailure } from '../../context.js';
import { applyUsers, type SeedUserEntry } from '../../seed-apply.js';
import { RENAMES } from '../../arguments/auth.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'auth',
  method: 'importUsers',
  sdkOrigin: 'firebase-admin',
  effect: 'write',
  signature: 'importUsers(users[])',
  description: 'Load many records, in the users shape sandbox.seed takes.',
  args: z.object({
    users: z.array(userSeed).describe('The records to load, in order.'),
  }),
  operation: 'import_auth_users',
  renames: RENAMES,
  example: {
    users: [
      { uid: 'alice', email: 'alice@example.com', customClaims: { role: 'owner' } },
      { uid: 'riley', email: 'riley@acme.test', tenantId: 'tenant-acme' },
    ],
  },
  validate: (args, { fail }) => checkUserFields(args, fail),
  async handler(args, ctx) {
    const users = args.users as SeedUserEntry[];
    try {
      applyUsers(ctx.sandbox, users);
    } catch (error) {
      return operationFailure(error instanceof Error ? error.message : String(error));
    }
    for (const user of users) ctx.identity.remember(user.uid, user.tenantId, user.customClaims);
    return {
      ok: true,
      summary: `Imported ${users.length} user${users.length === 1 ? '' : 's'}.`,
      data: { imported: users.map((user) => user.uid) },
    };
  },
} satisfies MethodRecord;
