/** Return the sandbox clock to the wall clock. */
import { z } from 'zod';
import { getClock } from 'pyric/sandbox';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox',
  method: 'resetClock',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'resetClock()',
  description: 'Return to the wall clock.',
  args: z.object({}),
  operation: 'reset_clock',
  example: {},
  async handler(_args, ctx) {
    const clock = getClock(ctx.sandbox);
    clock.reset();
    return {
      ok: true,
      summary: `Clock reset to the wall clock at ${clock.date().toISOString()}.`,
      data: { mode: clock.mode, now: clock.now() },
    };
  },
} satisfies MethodRecord;
