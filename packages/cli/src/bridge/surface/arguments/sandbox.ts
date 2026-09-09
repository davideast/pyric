/**
 * The `sandbox` tool's argument vocabulary: the names, shapes, and reads of the
 * project directory that more than one of its methods needs.
 *
 * `seed` is the one method here with nested arguments, and its user entries are
 * where the Admin SDK naming gap reappears: `auth.createUser` already rejects
 * `claims` and `tenant` in favor of `customClaims` and `tenantId`, and a seed
 * that quietly dropped them would leave the tenant or the claim out of the
 * sandbox with nothing said.
 *
 * The branch methods share more than a schema. Six of them name a branch, four
 * have to say the same thing when the project holds no branch by that name, and
 * one reads a file the caller named. Those are the pieces that would otherwise
 * be written six times and drift, so they live here and the records carry only
 * what is their own.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { SandboxEvent } from 'pyric/sandbox';
import { BRANCH_NAME_PATTERN, listBranches } from 'pyric/sandbox/branches/store';
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

/** The value of `against` that names the live sandbox rather than a checkpoint. */
export const AGAINST_LIVE = 'live';

/** The recorded session a `sandbox.apply` call reads when it names no other. */
export const DEFAULT_SESSION_PATH = '.pyric/last-session.json';

/**
 * The branch a method names. It is a directory name under the branch store, so
 * the shape is checked by the validator and a name that could reach outside
 * that directory never gets as far as a handler.
 */
export const branchName = z
  .string()
  .regex(
    BRANCH_NAME_PATTERN,
    'a branch name is 1 to 64 characters of lowercase letters, digits, dot, dash, or underscore, starting with a letter or digit',
  )
  .describe(
    'The branch name, which is its directory under .pyric/state/branches. Lowercase letters, digits, dot, dash, and underscore.',
  );

/**
 * The rule sources a fork runs its branch under in place of live's.
 *
 * Two spellings, because two things are common. A string is the Firestore
 * ruleset, which is what a caller trying one rule change has in hand. An
 * object names the service each source belongs to, so a branch can try a
 * Storage or a Realtime Database ruleset, or two at once, without saying
 * anything about the third. A service the call leaves out keeps live's rules.
 */
export const candidateRules = z
  .union([
    z.string(),
    z.object({
      firestore: z.string().optional(),
      database: z.record(z.unknown()).optional(),
      storage: z.string().optional(),
    }),
  ])
  .optional()
  .describe(
    'Rules the branch runs under in place of live: a Firestore rules string, or an object naming firestore, database, and storage.',
  );

/**
 * Whether the project already holds a branch under this name.
 *
 * The store decides what a branch is, so this reads its listing rather than
 * the directory: a directory the store would skip is not a branch any method
 * can load, and counting it would refuse a fork under a name nothing holds.
 */
export function branchExists(projectDir: string, name: string): boolean {
  return storedBranchNames(projectDir).includes(name);
}

/** Every branch the project holds, as the store lists them. */
function storedBranchNames(projectDir: string): string[] {
  return listBranches(projectDir).map((entry) => entry.name);
}

/** The one refusal every method that names a missing branch returns. */
export function refuseUnknownBranch(
  projectDir: string,
  name: string,
  fail: Fail,
): InvalidArguments {
  const known = storedBranchNames(projectDir);
  if (known.length === 0) {
    return fail(
      `the project holds no branch named '${name}', and no branches at all.`,
      'Call fork to create one.',
      'branch',
    );
  }
  return fail(
    `the project holds no branch named '${name}'. It holds ${known.join(', ')}.`,
    `Pass 'branch' as a branch the project holds, or call fork to create '${name}'.`,
    'branch',
  );
}

/**
 * A path inside the project directory, or a refusal naming why it is not one.
 *
 * One rule for every method that names a file. A relative path resolves
 * against the project directory and an absolute one is taken as written, and
 * either way the result has to land inside the project directory: a sandbox
 * method reads and writes a project's own files and nothing above them. The
 * three methods that take a path had two rules between them, so the same
 * absolute path was a fixture one would write and a session another refused.
 */
export function projectPathWithin(
  projectDir: string,
  candidate: string,
  field: string,
  fail: Fail,
): { path: string } | InvalidArguments {
  const resolved = isAbsolute(candidate) ? candidate : resolve(projectDir, candidate);
  const inside = relative(projectDir, resolved);
  if (inside.startsWith('..') || isAbsolute(inside)) {
    return fail(
      `'${field}' is '${candidate}', which is outside the project directory.`,
      `Pass '${field}' as a path inside the project directory, such as '${DEFAULT_SESSION_PATH}'.`,
      field,
    );
  }
  return { path: resolved };
}

/**
 * The events a recorded session file carries. A session file is the fixture
 * the capture writes: an object with an `events` array. A bare array is
 * accepted too, because that is what a caller who saved only the event log
 * has in hand.
 */
export function readSessionEvents(path: string): SandboxEvent[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) return parsed as SandboxEvent[];
  if (parsed === null || typeof parsed !== 'object') return null;
  const events = (parsed as { events?: unknown }).events;
  if (!Array.isArray(events)) return null;
  return events as SandboxEvent[];
}

/**
 * Refuse an `apply` call that names neither an event list nor a session file,
 * or both. There is no default: applying the last recorded session because a
 * call said nothing would change a branch the caller did not ask to change.
 */
export function refuseAmbiguousSource(args: Args, fail: Fail): InvalidArguments | null {
  const hasEvents = args.events !== undefined;
  const hasSession = args.sessionPath !== undefined;
  if (hasEvents && !hasSession) return null;
  if (hasSession && !hasEvents) return null;
  if (hasEvents && hasSession) {
    return fail(
      "'events' and 'sessionPath' name two different sources for the same call.",
      "Pass 'events' with the events to apply, or 'sessionPath' with the recorded session to read, not both.",
      'events',
    );
  }
  return fail(
    'apply names the events it applies, and this call named none.',
    `Pass 'events' with the events to apply, or 'sessionPath' with a recorded session such as '${DEFAULT_SESSION_PATH}'.`,
    'events',
  );
}
