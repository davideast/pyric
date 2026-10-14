/**
 * The `database` tool's argument vocabulary.
 *
 * The one rule worth checking here is the key character set. Realtime Database
 * keys cannot hold `.`, `#`, `$`, `[` or `]`, and a path built by joining a
 * field value (an email, most often) silently produces one, so the write fails
 * far from the mistake unless it is caught at the argument.
 *
 * Every method also takes `instance`, which is parsed by the SDK's own URL
 * rules, so a malformed name or URL is refused with the message `getDatabase`
 * would throw.
 */
import { z } from 'zod';
import { resolveDatabaseInstance } from 'pyric/sandbox/internal';
import type { Args, Fail, InvalidArguments } from '../method-types.js';
import { quoted } from '../closest-name.js';

/** Characters a Realtime Database key cannot hold. */
const FORBIDDEN = ['.', '#', '$', '[', ']'];

/** The SDK and Admin SDK spellings of a database URL, mapped onto `instance`. */
export const INSTANCE_RENAMES: Readonly<Record<string, string>> = {
  url: 'instance',
  databaseURL: 'instance',
  databaseUrl: 'instance',
};

export const RENAMES: Readonly<Record<string, string>> = {
  ref: 'path',
  reference: 'path',
  key: 'path',
  data: 'value',
  limit: 'limitToFirst',
  orderBy: 'orderByChild',
  ...INSTANCE_RENAMES,
};

export const pathArgument = z.string().describe('Root-relative path, for example rooms/lobby.');

export const instanceArgument = z
  .string()
  .optional()
  .describe('The Realtime Database instance: a name such as shard-00, its URL, or default. Omitted, the default instance.');

/** Reject a path holding a character the key grammar forbids. */
export function checkPath(method: string, args: Args, fail: Fail): InvalidArguments | null {
  const path = String(args.path);
  const found = FORBIDDEN.find((character) => path.includes(character));
  if (found === undefined) return null;
  return fail(
    `path ${quoted(path)} contains '${found}'. Realtime Database keys cannot contain ${FORBIDDEN.map((character) => `'${character}'`).join(', ')}, so ${method} rejects the reference.`,
    `Remove '${found}' from the path, or encode it.`,
    'path',
  );
}

/** Reject an instance the SDK cannot parse, with the SDK's message. */
export function checkInstance(args: Args, fail: Fail): InvalidArguments | null {
  if (args.instance === undefined) return null;
  try {
    resolveDatabaseInstance(String(args.instance));
    return null;
  } catch (error) {
    const reason = error instanceof Error ? error.message.trim() : String(error);
    return fail(
      `instance ${quoted(args.instance)} is not a database instance. ${reason}`,
      'Pass an instance name such as shard-00, its root URL such as https://shard-00.firebaseio.com, or default.',
      'instance',
    );
  }
}

/** Check a call's reference: the path, then the instance. */
export function checkReference(method: string, args: Args, fail: Fail): InvalidArguments | null {
  return checkPath(method, args, fail) ?? checkInstance(args, fail);
}
