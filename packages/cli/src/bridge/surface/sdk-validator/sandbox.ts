/**
 * The `sandbox` tool: the state of the sandbox itself, which no Firebase SDK
 * has a method for, so the names here are the tooling names.
 *
 * `reset` takes an explicit confirmation. It clears every service at once, it
 * is one word away from `inspect` in an agent's vocabulary, and the state it
 * clears is the state a task was seeded with, so the cost of an accidental call
 * is the whole run.
 */
import { z } from 'zod';
import type { MethodSpec, ToolSpec } from './shared.js';
import { quoted } from './shared.js';

const METHODS: readonly MethodSpec[] = [
  {
    name: 'inspect',
    sdkOrigin: 'pyric',
    signature: 'inspect()',
    summary: 'Report the loaded rules, the document census, and the recent requests and denials.',
    args: z.object({}),
    operations: ['inspect_sandbox'],
    example: {},
    resolve: () => 'inspect_sandbox',
    translate: () => ({}),
  },
  {
    name: 'reset',
    sdkOrigin: 'pyric',
    signature: 'reset(confirm)',
    summary: 'Clear every service. Requires confirm true.',
    args: z.object({
      confirm: z
        .boolean()
        .optional()
        .describe('Must be true. Reset clears documents, values, objects, and users.'),
    }),
    operations: ['reset_sandbox'],
    renames: { confirmed: 'confirm', force: 'confirm', yes: 'confirm' },
    example: { confirm: true },
    resolve: () => 'reset_sandbox',
    translate: () => ({}),
    check: (args, fail) => {
      if (args.confirm === true) return null;
      return fail(
        `confirm is ${quoted(args.confirm)}. reset clears documents, database values, stored objects, and users in one call, so it takes an explicit confirmation.`,
        `Pass confirm: true.`,
        'confirm',
      );
    },
  },
  {
    name: 'seed',
    sdkOrigin: 'pyric',
    signature: 'seed(users?, firestore?, database?, storage?, firestoreRules?, databaseRules?, storageRules?)',
    summary: 'Load users, documents, database values, storage objects, and rules before other calls run.',
    args: z.object({
      users: z
        .array(z.object({
          uid: z.string(),
          email: z.string().optional(),
          claims: z.record(z.unknown()).optional(),
          tenant: z.string().optional(),
        }))
        .optional()
        .describe('Users to seed into the auth pool.'),
      firestore: z
        .record(z.record(z.unknown()))
        .optional()
        .describe('Document path to document data.'),
      database: z.record(z.unknown()).optional().describe('Realtime Database tree written at the root.'),
      storage: z
        .array(z.object({
          path: z.string(),
          contentBase64: z.string(),
          contentType: z.string().optional(),
        }))
        .optional()
        .describe('Storage objects to seed.'),
      firestoreRules: z.string().optional().describe('Firestore rules source to install before seeding data.'),
      databaseRules: z.string().optional().describe('Realtime Database rules.json source to install before seeding data.'),
      storageRules: z.string().optional().describe('Storage rules source to install before seeding data.'),
    }),
    operations: ['seed_sandbox'],
    example: { firestore: { 'users/alice': { role: 'admin' } } },
    resolve: () => 'seed_sandbox',
    translate: (args) => ({ ...args }),
  },
];

export const SANDBOX_TOOL: ToolSpec = {
  name: 'sandbox',
  intro:
    'The sandbox itself: what it holds, clearing it, and loading a snapshot into it. These have no Firebase SDK counterpart, so the method names are the tooling names.',
  methods: METHODS,
};
