/**
 * Load state into the sandbox before an agent's calls begin.
 *
 * The shape is the one the evaluation harness seeds a task with, so a task's
 * seed and an agent's own seed call describe state one way and take one code
 * path.
 */
import { z } from 'zod';
import { checkUserFields, storageObjectSeed, userSeed } from '../../arguments/sandbox.js';
import { operationFailure } from '../../context.js';
import { applyData, applyRules, type SandboxSeed } from '../../seed-apply.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox',
  method: 'seed',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature:
    'seed(users?, firestore?, database?, storage?, firestoreRules?, databaseRules?, storageRules?)',
  description: 'Load users, documents, values, objects, rules.',
  args: z.object({
    users: z
      .array(userSeed)
      .optional()
      .describe(
        'Users to seed into the auth pool. Admin SDK field names: customClaims, tenantId.',
      ),
    firestore: z
      .record(z.record(z.unknown()))
      .optional()
      .describe('Document path to document data.'),
    database: z
      .record(z.unknown())
      .optional()
      .describe('Realtime Database tree written at the root.'),
    storage: z.array(storageObjectSeed).optional().describe('Storage objects to seed.'),
    firestoreRules: z
      .string()
      .optional()
      .describe('Firestore rules source to install before seeding data.'),
    databaseRules: z
      .string()
      .optional()
      .describe('Realtime Database rules.json source to install before seeding data.'),
    storageRules: z
      .string()
      .optional()
      .describe('Storage rules source to install before seeding data.'),
  }),
  operation: 'seed_sandbox',
  example: { firestore: { 'users/alice': { role: 'admin' } } },
  validate: (args, { fail }) => checkUserFields(args, fail),
  async handler(args, ctx) {
    const seed = args as SandboxSeed;
    try {
      await applyRules(ctx.sandbox, seed);
      await applyData(ctx.sandbox, seed);
    } catch (error) {
      return operationFailure(error instanceof Error ? error.message : String(error));
    }
    return { ok: true, summary: 'Sandbox seeded.' };
  },
} satisfies MethodRecord;
