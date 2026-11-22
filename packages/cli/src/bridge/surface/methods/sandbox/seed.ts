/**
 * Load state into the sandbox before an agent's calls begin.
 *
 * The shape is the one the evaluation harness seeds a task with, so a task's
 * seed and an agent's own seed call describe state one way and take one code
 * path.
 */
import { z } from 'zod';
import { checkUserFields, storageObjectSeed, userSeed } from '../../arguments/seed.js';
import { quoted } from '../../closest-name.js';
import { operationFailure } from '../../sandbox-context.js';
import { applyData, applyRules, type SandboxSeed } from '../../seed-apply.js';
import type { Args, Fail, InvalidArguments, MethodRecord } from '../../method-types.js';

function checkFirestoreDatabasesSeed(args: Args, fail: Fail): InvalidArguments | null {
  const raw = args.firestoreDatabases;
  if (raw === undefined) return null;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail(
      `firestoreDatabases is ${quoted(raw)}, not a map of database ids to document maps.`,
      'Pass firestoreDatabases as { [databaseId]: { [docPath]: { ...fields } } }.',
      'firestoreDatabases',
    );
  }
  for (const [dbId, docs] of Object.entries(raw as Record<string, unknown>)) {
    if (docs === null || typeof docs !== 'object' || Array.isArray(docs)) {
      return fail(
        `firestoreDatabases.${dbId} is ${quoted(docs)}, not a document map.`,
        `Pass firestoreDatabases.${dbId} as { [docPath]: { ...fields } }.`,
        'firestoreDatabases',
      );
    }
    for (const [docPath, docData] of Object.entries(docs as Record<string, unknown>)) {
      if (docData === null || typeof docData !== 'object' || Array.isArray(docData)) {
        return fail(
          `firestoreDatabases.${dbId}['${docPath}'] is ${quoted(docData)}, not a document object.`,
          `Pass firestoreDatabases.${dbId}['${docPath}'] as an object of document fields.`,
          'firestoreDatabases',
        );
      }
    }
  }
  return null;
}

export default {
  tool: 'sandbox',
  method: 'seed',
  runsIn: 'sandbox',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature:
    'seed(users?, firestore?, firestoreDatabases?, firestoreDeclared?, database?, storage?, firestoreRules?, databaseRules?, storageRules?)',
  description: 'Seed state and rules.',
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
    firestoreDatabases: z
      .record(z.record(z.unknown()))
      .optional()
      .describe('Named Firestore database id to document path/data map.'),
    firestoreDeclared: z
      .array(z.string())
      .optional()
      .describe('Named Firestore database ids to declare (even when empty).'),
    database: z
      .union([
        z.record(z.unknown()),
        z.array(z.unknown()),
        z.string(),
        z.number().finite(),
        z.boolean(),
      ])
      .optional()
      .describe('Realtime Database tree written at the root.'),
    storage: z.array(storageObjectSeed).optional().describe('Storage objects to seed.'),
    firestoreRules: z
      .union([z.string(), z.record(z.string())])
      .optional()
      .describe(
        'Firestore rules source for (default), or database id to rules source map, installed before seeding data.',
      ),
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
  renames: { firestoreDatabaseRules: 'firestoreRules' },
  example: { firestore: { 'users/alice': { role: 'admin' } } },
  validate: (args, { fail }) =>
    checkUserFields(args, fail) ?? checkFirestoreDatabasesSeed(args, fail),
  async handler(args, ctx) {
    const seed = args as SandboxSeed;
    let refusals: string[];
    try {
      refusals = await applyRules(ctx.sandbox, seed);
      await applyData(ctx.sandbox, seed);
    } catch (error) {
      return operationFailure(error instanceof Error ? error.message : String(error));
    }
    if (refusals.length === 0) return { ok: true, summary: 'Sandbox seeded.' };
    // The data is seeded; rules production would not load are not installed.
    return {
      ok: true,
      summary: `Sandbox seeded. Rules not installed, the sandbox keeps the rules in force: ${refusals.join(' ')}`,
      data: { refusedRules: refusals },
    };
  },
} satisfies MethodRecord;
