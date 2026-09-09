/**
 * The `sandbox` tool's argument vocabulary.
 *
 * `seed` is the one method here with nested arguments, and its user entries are
 * where the Admin SDK naming gap reappears: `auth.createUser` already rejects
 * `claims` and `tenant` in favor of `customClaims` and `tenantId`, and a seed
 * that quietly dropped them would leave the tenant or the claim out of the
 * sandbox with nothing said.
 */
import { z } from 'zod';
import type { Args, Fail, InvalidArguments } from '../method-types.js';
import { closest, quoted } from '../closest-name.js';

/** The fields a `seed` users entry accepts, after the Admin SDK rename. */
const USER_FIELDS = ['uid', 'email', 'customClaims', 'tenantId'] as const;

/** Client SDK spellings of the two user fields the Admin SDK names differently. */
const USER_FIELD_RENAMES: Readonly<Record<string, string>> = {
  claims: 'customClaims',
  tenant: 'tenantId',
};

/** One seeded user, under the Admin SDK field names. */
export const userSeed = z.object({
  uid: z.string(),
  email: z.string().optional(),
  customClaims: z.record(z.unknown()).optional(),
  tenantId: z.string().optional(),
});

/** One seeded storage object. */
export const storageObjectSeed = z.object({
  path: z.string(),
  contentBase64: z.string(),
  contentType: z.string().optional(),
  customMetadata: z.record(z.string()).optional(),
});

/**
 * Reject a `users` entry field the schema does not declare. The seed schema
 * strips unknown keys rather than failing on them, so this walks the raw
 * arguments a client sent, not the parsed result, the same way the shared
 * validator walks a method's top-level arguments.
 */
export function checkUserFields(args: Args, fail: Fail): InvalidArguments | null {
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
