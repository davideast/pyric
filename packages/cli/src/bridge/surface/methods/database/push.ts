/**
 * Mint an auto-id child key under one Realtime Database path.
 *
 * A push key is minted from the sandbox clock's own instant (step 5), which
 * is what keeps two pushes issued in the same millisecond ordered the same
 * way the real key format orders them.
 */
import { z } from 'zod';
import { push, ref } from 'pyric/database';
import { checkReference, instanceArgument, pathArgument, RENAMES } from '../../arguments/database.js';
import { instanceSelector, onInstance } from '../../database-instance.js';
import { databaseFor } from '../../service-handles.js';
import type { MethodRecord } from '../../method-types.js';

/** The path and key a push resolved to, joined the way a caller would build the URL. */
function childPathOf(path: string, key: string): string {
  return path === '' ? key : `${path}/${key}`;
}

export default {
  tool: 'database',
  method: 'push',
  runsIn: 'sandbox',
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature: 'push(path, value?, instance?)',
  description:
    'Mint an auto-id child key under path. With value given, write it at the new child. With no value, only the key is minted; nothing is written at the new child, matching a push the SDK never resolves with data.',
  args: z.object({
    path: pathArgument,
    value: z
      .unknown()
      .optional()
      .describe('Written at the newly minted child. Omitted, only the key is minted.'),
    instance: instanceArgument,
  }),
  operation: 'push_database_value',
  renames: RENAMES,
  example: { path: 'rooms', value: { name: 'Overflow' } },
  validate: (args, { fail }) => checkReference('push', args, fail),
  async handler(args, ctx) {
    const path = String(args.path);
    const selector = await instanceSelector(ctx, args.instance);
    const pushed = push(ref(databaseFor(ctx, selector), path), args.value);
    const written = await pushed;
    const key = String(written.key);
    const childPath = childPathOf(path, key);
    const summary =
      args.value === undefined
        ? `Minted key ${key} under ${path}; nothing written`
        : `Pushed ${childPath}`;
    return { ok: true, summary: onInstance(summary, selector), data: { key, path: childPath } };
  },
} satisfies MethodRecord;
