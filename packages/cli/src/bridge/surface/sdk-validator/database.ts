/**
 * The `database` tool: the modular Realtime Database SDK's method names, with a
 * path string standing in for the `Reference` a real call would carry.
 *
 * The one rule worth checking here is the key character set. Realtime Database
 * keys cannot hold `.`, `#`, `$`, `[` or `]`, and a path built by joining a
 * field value (an email, most often) silently produces one, so the write fails
 * far from the mistake unless it is caught at the argument.
 */
import { z } from 'zod';
import type { Args, Fail, InvalidArguments, MethodSpec, ToolSpec } from './shared.js';
import { quoted } from './shared.js';

/** Characters a Realtime Database key cannot hold. */
const FORBIDDEN = ['.', '#', '$', '[', ']'];

const RENAMES: Readonly<Record<string, string>> = {
  ref: 'path',
  reference: 'path',
  key: 'path',
  data: 'value',
  limit: 'limitToFirst',
  orderBy: 'orderByChild',
};

/** Reject a path holding a character the key grammar forbids. */
function checkPath(method: string, args: Args, fail: Fail): InvalidArguments | null {
  const path = String(args.path);
  const found = FORBIDDEN.find((character) => path.includes(character));
  if (found === undefined) return null;
  return fail(
    `path ${quoted(path)} contains '${found}'. Realtime Database keys cannot contain ${FORBIDDEN.map((character) => `'${character}'`).join(', ')}, so ${method} rejects the reference.`,
    `Remove '${found}' from the path, or encode it.`,
    'path',
  );
}

const pathArgument = z.string().describe('Root-relative path, for example rooms/lobby.');

const METHODS: readonly MethodSpec[] = [
  {
    name: 'get',
    sdkOrigin: 'firebase-js',
    signature: 'get(path)',
    summary: 'Read the value at one path.',
    args: z.object({ path: pathArgument }),
    operations: ['get_database_value'],
    renames: RENAMES,
    example: { path: 'rooms/lobby' },
    resolve: () => 'get_database_value',
    translate: (args) => ({ path: args.path }),
    check: (args, fail) => checkPath('get', args, fail),
  },
  {
    name: 'set',
    sdkOrigin: 'firebase-js',
    signature: 'set(path, value)',
    summary: 'Replace the value at one path.',
    args: z.object({
      path: pathArgument,
      value: z.unknown().describe('The value written at the path. Replaces whatever is there.'),
    }),
    operations: ['write_database_value'],
    renames: RENAMES,
    example: { path: 'rooms/lobby', value: { name: 'Lobby' } },
    resolve: () => 'write_database_value',
    translate: (args) => ({ path: args.path, value: args.value }),
    check: (args, fail) => checkPath('set', args, fail),
  },
  {
    name: 'update',
    sdkOrigin: 'firebase-js',
    signature: 'update(path, values)',
    summary: 'Merge child keys into the value at one path.',
    args: z.object({
      path: pathArgument,
      values: z
        .record(z.unknown())
        .describe('Child keys to merge into the path. Other children are left alone.'),
    }),
    operations: ['update_database_value'],
    renames: { ...RENAMES, value: 'values' },
    example: { path: 'rooms/lobby', values: { topic: 'welcome' } },
    resolve: () => 'update_database_value',
    translate: (args) => ({ path: args.path, value: args.values }),
    check: (args, fail) => checkPath('update', args, fail),
  },
  {
    name: 'remove',
    sdkOrigin: 'firebase-js',
    signature: 'remove(path)',
    summary: 'Delete the value at one path.',
    args: z.object({ path: pathArgument }),
    operations: ['delete_database_value'],
    renames: RENAMES,
    example: { path: 'rooms/lobby' },
    resolve: () => 'delete_database_value',
    translate: (args) => ({ path: args.path }),
    check: (args, fail) => checkPath('remove', args, fail),
  },
  {
    name: 'query',
    sdkOrigin: 'firebase-js',
    signature: 'query(path, orderByChild?, equalTo?, limitToFirst?)',
    summary: 'Read the children of one path under an ordering, a filter, and a limit.',
    args: z.object({
      path: z.string().describe('Root-relative path whose children are queried.'),
      orderByChild: z.string().optional().describe('Child key the query orders and filters by.'),
      equalTo: z
        .union([z.string(), z.number(), z.boolean()])
        .optional()
        .describe('Keep only children whose ordered value equals this.'),
      limitToFirst: z
        .number()
        .optional()
        .describe('Return at most this many children from the start.'),
    }),
    operations: ['query_database_values'],
    renames: RENAMES,
    example: { path: 'rooms', orderByChild: 'owner', equalTo: 'alice', limitToFirst: 10 },
    resolve: () => 'query_database_values',
    translate: (args) => {
      const call: Args = { path: args.path };
      if (args.orderByChild !== undefined) call.orderByChild = args.orderByChild;
      if (args.equalTo !== undefined) call.equalTo = args.equalTo;
      if (args.limitToFirst !== undefined) call.limitToFirst = args.limitToFirst;
      return call;
    },
    check: (args, fail) => {
      const path = checkPath('query', args, fail);
      if (path !== null) return path;
      if (args.equalTo !== undefined && args.orderByChild === undefined) {
        return fail(
          `equalTo is ${quoted(args.equalTo)} with no orderByChild. The SDK filters only along an ordering.`,
          `Pass orderByChild naming the child key equalTo compares.`,
          'orderByChild',
        );
      }
      return null;
    },
  },
];

export const DATABASE_TOOL: ToolSpec = {
  name: 'database',
  intro:
    'Realtime Database in the sandbox, called with the modular SDK method names and argument names. A reference is a root-relative path string.',
  methods: METHODS,
};
