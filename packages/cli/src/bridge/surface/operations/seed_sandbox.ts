/** Restore the whole sandbox from a snapshot. */
import { z } from 'zod';
import type { SandboxSnapshot } from 'pyric/sandbox';
import { operationFailure } from '../context.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  snapshot: z
    .record(z.unknown())
    .describe('A sandbox snapshot, as inspect and the persisted state file produce it.'),
});

export default {
  verb: 'seed',
  service: 'sandbox',
  object: 'state',
  description: 'Restore the whole sandbox from a snapshot, replacing everything currently stored.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    try {
      ctx.sandbox.loadSnapshot(input.snapshot as unknown as SandboxSnapshot);
    } catch (error) {
      return operationFailure(error instanceof Error ? error.message : String(error));
    }
    return { ok: true, summary: 'Sandbox seeded from the supplied snapshot.' };
  },
} satisfies OperationRecord;
