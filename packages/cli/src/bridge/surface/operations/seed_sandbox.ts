/**
 * Load state into the sandbox before an agent's calls begin, in the same
 * shape the eval harness seeds a task with (`EvalSeed`), so a task's seed and
 * an agent's own seed call describe state one way.
 */
import { z } from 'zod';
import { operationFailure } from '../context.js';
import { applyData, applyRules } from '../seed-apply.js';
import type { OperationRecord } from '../types.js';

const userSeed = z.object({
  uid: z.string().describe('The user id.'),
  email: z.string().optional().describe('Email address. Defaults to a sandbox-local address.'),
  claims: z
    .record(z.unknown())
    .optional()
    .describe('Custom claims. Rules read them as request.auth.token.<name>.'),
  tenant: z
    .string()
    .optional()
    .describe('Identity Platform tenant. Rules read it as request.auth.token.firebase.tenant.'),
});

const storageObjectSeed = z.object({
  path: z.string().describe('Object path within the default bucket.'),
  contentBase64: z.string().describe('Object bytes, base64 encoded.'),
  contentType: z.string().optional().describe('MIME type of the object.'),
});

const ACCEPTED_KEYS = [
  'users',
  'firestore',
  'database',
  'storage',
  'firestoreRules',
  'databaseRules',
  'storageRules',
] as const;

const parameters = z
  .object({
    users: z.array(userSeed).optional().describe('Users to seed into the auth pool.'),
    firestore: z
      .record(z.record(z.unknown()))
      .optional()
      .describe('Document path to document data.'),
    database: z.record(z.unknown()).optional().describe('Realtime Database tree written at the root.'),
    storage: z.array(storageObjectSeed).optional().describe('Storage objects to seed.'),
    firestoreRules: z.string().optional().describe('Firestore rules source to install before seeding data.'),
    databaseRules: z.string().optional().describe('Realtime Database rules.json source to install before seeding data.'),
    storageRules: z.string().optional().describe('Storage rules source to install before seeding data.'),
  })
  .strict();

export default {
  verb: 'seed',
  service: 'sandbox',
  object: 'state',
  description:
    'Load users, documents, database values, storage objects, and rules into the sandbox before other calls run. Every field is optional.',
  parameters,
  async handler(args, ctx) {
    const parsed = parameters.safeParse(args);
    if (!parsed.success) {
      const unrecognized = parsed.error.issues.find((issue) => issue.code === 'unrecognized_keys');
      if (unrecognized !== undefined && unrecognized.code === 'unrecognized_keys') {
        return operationFailure(
          `seed does not accept ${unrecognized.keys.map((key) => `'${key}'`).join(', ')}. ` +
            `Pass only ${ACCEPTED_KEYS.join(', ')}.`,
        );
      }
      return operationFailure(parsed.error.issues[0]?.message ?? 'The seed is not valid.');
    }
    const seed = parsed.data;
    try {
      await applyRules(ctx.sandbox, seed);
      await applyData(ctx.sandbox, seed);
    } catch (error) {
      return operationFailure(error instanceof Error ? error.message : String(error));
    }
    return { ok: true, summary: 'Sandbox seeded.' };
  },
} satisfies OperationRecord;
