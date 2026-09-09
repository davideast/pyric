/**
 * Clear one service, or every service, in the sandbox.
 *
 * `reset` is destructive, so the shared effect enforcement in
 * `method-validation.ts` refuses the call unless `args.confirm === true`
 * before this record's own `handler` ever runs. The default scope, `all`,
 * clears every service at once, is one word away from `inspect` in an
 * agent's vocabulary, and the state it clears is the state a task was seeded
 * with, so the cost of an accidental call is the whole run. A named scope
 * clears only that service's data; the others are untouched.
 */
import { z } from 'zod';
import { getAdminDatabase, ref as databaseRef, remove as databaseRemove } from 'pyric/database';
import { deleteObject, ref as storageRef } from 'pyric/storage';
import { getAdminStorageSandbox } from 'pyric/storage/internal';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { listStoredPaths } from '../../../server/storage-sidecar.js';
import type { MethodRecord } from '../../method-types.js';
import type { SurfaceContext } from '../../types.js';

const SCOPES = ['all', 'firestore', 'database', 'storage', 'auth'] as const;
type Scope = (typeof SCOPES)[number];

async function resetScope(scope: Scope, ctx: SurfaceContext): Promise<void> {
  if (scope === 'firestore') {
    ctx.sandbox.reset();
    return;
  }
  if (scope === 'database') {
    await databaseRemove(databaseRef(getAdminDatabase(ctx.sandbox)));
    return;
  }
  if (scope === 'storage') {
    const storage = getAdminStorageSandbox(ctx.sandbox);
    for (const path of await listStoredPaths(storage)) {
      await deleteObject(storageRef(storage, path));
    }
    return;
  }
  authSandbox.clearUsers(getAuth(ctx.sandbox));
}

export default {
  tool: 'sandbox',
  method: 'reset',
  sdkOrigin: 'pyric',
  effect: 'destructive',
  signature: 'reset(scope?: all|firestore|database|storage|auth, confirm)',
  description:
    'Discards documents, values, objects, and users. scope narrows this to one service; the default, all, clears every service.',
  args: z.object({
    scope: z.enum(SCOPES).optional(),
    confirm: z
      .boolean()
      .optional()
      .describe('Must be true. Reset clears documents, values, objects, and users.'),
  }),
  operation: 'reset_sandbox',
  renames: { confirmed: 'confirm', force: 'confirm', yes: 'confirm' },
  example: { confirm: true },
  async handler(args, ctx) {
    const scope = (typeof args.scope === 'string' ? args.scope : 'all') as Scope;
    if (scope === 'all') {
      const outcome = await ctx.sandbox.resetAll();
      if (outcome.errors.length > 0) {
        return {
          ok: false,
          summary: `Reset finished with ${outcome.errors.length} service errors.`,
          data: { errors: outcome.errors },
        };
      }
      return { ok: true, summary: 'Sandbox reset.', data: { errors: [] } };
    }
    await resetScope(scope, ctx);
    return { ok: true, summary: `Reset the ${scope} service.`, data: { scope } };
  },
} satisfies MethodRecord;
