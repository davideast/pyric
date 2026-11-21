/** Move the sandbox clock forward by a number of milliseconds. */
import { z } from 'zod';
import {
  getClock,
  isClockInstantInRange,
  MAX_CLOCK_EPOCH_MS,
  MIN_CLOCK_EPOCH_MS,
} from 'pyric/sandbox';
import { quoted } from '../../closest-name.js';
import { failFor } from '../../method-validation.js';
import type { MethodRecord } from '../../method-types.js';

const MAX_CLOCK_SPAN_MS = MAX_CLOCK_EPOCH_MS - MIN_CLOCK_EPOCH_MS;
const fail = failFor('sandbox', 'advanceClock');

export default {
  tool: 'sandbox',
  method: 'advanceClock',
  runsIn: 'sandbox',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'advanceClock(ms)',
  description: 'Advance clock by ms.',
  args: z.object({
    ms: z.number().int().positive().describe('Milliseconds to advance the clock by.'),
  }),
  operation: 'advance_clock',
  example: { ms: 3600000 },
  validate(args, ctx) {
    if (typeof args.ms === 'number' && args.ms > MAX_CLOCK_SPAN_MS) {
      return ctx.fail(
        `ms is ${quoted(args.ms)}, which moves the clock past 9999-12-31T23:59:59.999Z.`,
        'Pass a smaller ms so the sandbox clock stays at or before 9999-12-31T23:59:59.999Z.',
        'ms',
      );
    }
    return null;
  },
  async handler(args, ctx) {
    const ms = Number(args.ms);
    const clock = getClock(ctx.sandbox);
    const targetInstant = clock.nextInstantAfterAdvance(ms);
    if (!isClockInstantInRange(targetInstant)) {
      return fail(
        `ms is ${quoted(ms)}, which moves the clock from ${clock.date().toISOString()} past 9999-12-31T23:59:59.999Z.`,
        'Pass a smaller ms so the sandbox clock stays at or before 9999-12-31T23:59:59.999Z.',
        'ms',
      );
    }
    clock.advance(ms);
    return {
      ok: true,
      summary: `Advanced the clock ${ms}ms; now ${clock.mode} at ${clock.date().toISOString()}.`,
      data: { mode: clock.mode, now: clock.now() },
    };
  },
} satisfies MethodRecord;
