/** Pin the sandbox clock to an instant, frozen there. */
import { z } from 'zod';
import { getClock } from 'pyric/sandbox';
import { quoted } from '../../closest-name.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox',
  method: 'setClock',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'setClock(isoTime)',
  description: 'Pin the clock to isoTime, frozen there.',
  args: z.object({
    isoTime: z.string().describe('An ISO 8601 instant, such as 2026-09-09T12:00:00.000Z.'),
  }),
  operation: 'set_clock',
  example: { isoTime: '2026-09-09T12:00:00.000Z' },
  validate(args, { fail }) {
    const isoTime = args.isoTime;
    if (typeof isoTime !== 'string') return null;
    if (Number.isNaN(Date.parse(isoTime))) {
      return fail(
        `isoTime is ${quoted(isoTime)}, which does not parse as a date.`,
        `Pass isoTime as an ISO 8601 string, such as '2026-09-09T12:00:00.000Z'.`,
        'isoTime',
      );
    }
    return null;
  },
  async handler(args, ctx) {
    const epochMs = Date.parse(String(args.isoTime));
    const clock = getClock(ctx.sandbox);
    clock.set(epochMs);
    return {
      ok: true,
      summary: `Clock pinned to ${clock.date().toISOString()}.`,
      data: { mode: clock.mode, now: clock.now() },
    };
  },
} satisfies MethodRecord;
