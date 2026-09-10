/** Move the sandbox clock forward by a number of milliseconds. */
import { z } from 'zod';
import { getClock } from 'pyric/sandbox';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox',
  method: 'advanceClock',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'advanceClock(ms)',
  description:
    'Move the clock forward ms; from the wall clock it keeps flowing, from a pin it stays frozen at the new instant.',
  args: z.object({
    ms: z.number().int().positive().describe('Milliseconds to advance the clock by.'),
  }),
  operation: 'advance_clock',
  example: { ms: 3600000 },
  async handler(args, ctx) {
    const ms = Number(args.ms);
    const clock = getClock(ctx.sandbox);
    clock.advance(ms);
    return {
      ok: true,
      summary: `Advanced the clock ${ms}ms; now ${clock.mode} at ${clock.date().toISOString()}.`,
      data: { mode: clock.mode, now: clock.now() },
    };
  },
} satisfies MethodRecord;
