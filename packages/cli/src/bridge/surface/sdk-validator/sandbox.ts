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
    signature: 'seed(snapshot)',
    summary: 'Load a sandbox snapshot over the current state.',
    args: z.object({
      snapshot: z
        .record(z.unknown())
        .describe('A sandbox snapshot, as inspect and the persisted state file produce it.'),
    }),
    operations: ['seed_sandbox'],
    renames: { state: 'snapshot', data: 'snapshot' },
    example: { snapshot: { firestore: { 'users/alice': { role: 'admin' } } } },
    resolve: () => 'seed_sandbox',
    translate: (args) => ({ snapshot: args.snapshot }),
  },
];

export const SANDBOX_TOOL: ToolSpec = {
  name: 'sandbox',
  intro:
    'The sandbox itself: what it holds, clearing it, and loading a snapshot into it. These have no Firebase SDK counterpart, so the method names are the tooling names.',
  methods: METHODS,
};
