/**
 * The `database` tool's argument vocabulary.
 *
 * The one rule worth checking here is the key character set. Realtime Database
 * keys cannot hold `.`, `#`, `$`, `[` or `]`, and a path built by joining a
 * field value (an email, most often) silently produces one, so the write fails
 * far from the mistake unless it is caught at the argument.
 */
import { z } from 'zod';
import type { Args, Fail, InvalidArguments } from '../method-types.js';
import { quoted } from '../method-validation.js';

/** Characters a Realtime Database key cannot hold. */
const FORBIDDEN = ['.', '#', '$', '[', ']'];

export const RENAMES: Readonly<Record<string, string>> = {
  ref: 'path',
  reference: 'path',
  key: 'path',
  data: 'value',
  limit: 'limitToFirst',
  orderBy: 'orderByChild',
};

export const pathArgument = z.string().describe('Root-relative path, for example rooms/lobby.');

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
