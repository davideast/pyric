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
import type { Args, Fail, InvalidArguments, MethodSpec, ToolSpec } from './shared.js';
import { closest, quoted } from './shared.js';

/** The fields a `seed` users entry accepts, after the Admin SDK rename. */
const USER_FIELDS = ['uid', 'email', 'customClaims', 'tenantId'] as const;

/**
 * Argument names the eval found agents reaching for: the client SDK's
 * `claims`/`tenant`, which `auth.createUser` and `auth.setCustomUserClaims`
 * already reject in favor of the Admin SDK's own names. `seed` must reject
 * the same names the same way, or a tenant or claim silently never reaches
 * the sandbox.
 */
const USER_FIELD_RENAMES: Readonly<Record<string, string>> = {
  claims: 'customClaims',
  tenant: 'tenantId',
};

/**
 * Reject a `users` entry field the schema does not declare. `seed`'s schema
 * strips unknown keys rather than failing on them (zod's default), so this
 * walks the raw arguments a client sent, not the parsed result, the same way
 * `checkArgumentNames` walks a method's top-level arguments.
 */
function checkUserFields(args: Args, fail: Fail): InvalidArguments | null {
  const users = args.users;
  if (!Array.isArray(users)) return null;
  for (const user of users) {
    if (user === null || typeof user !== 'object' || Array.isArray(user)) continue;
    for (const name of Object.keys(user as Record<string, unknown>)) {
      if ((USER_FIELDS as readonly string[]).includes(name)) continue;
      const renamed = USER_FIELD_RENAMES[name] ?? closest(name, [...USER_FIELDS]);
      if (renamed !== null && renamed !== undefined) {
        return fail(
          `users entry has unknown field ${quoted(name)}. seed names this field ${quoted(renamed)}.`,
          `Pass '${renamed}' instead of '${name}' in the users entry.`,
          `users.${name}`,
        );
      }
      return fail(
        `users entry has unknown field ${quoted(name)}. A users entry accepts ${USER_FIELDS.join(', ')}.`,
        `Remove '${name}' from the users entry.`,
        `users.${name}`,
      );
    }
  }
  return null;
}

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
          customClaims: z.record(z.unknown()).optional(),
          tenantId: z.string().optional(),
        }))
        .optional()
        .describe('Users to seed into the auth pool. Admin SDK field names: customClaims, tenantId.'),
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
    check: (args, fail) => checkUserFields(args, fail),
  },
];

export const SANDBOX_TOOL: ToolSpec = {
  name: 'sandbox',
  intro:
    'The sandbox itself: what it holds, clearing it, and loading a snapshot into it. These have no Firebase SDK counterpart, so the method names are the tooling names.',
  methods: METHODS,
};
