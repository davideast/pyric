/** Report what the sandbox holds. */
import { z } from 'zod';
import { getClock } from 'pyric/sandbox';
import { callSandboxTool } from '../../context.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox',
  method: 'inspect',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'inspect()',
  description: 'Report rules, counts, denials, the clock.',
  args: z.object({}),
  operation: 'inspect_sandbox',
  example: {},
  async handler(_args, ctx) {
    const result = await callSandboxTool(ctx, 'sandbox_inspect', {});
    if (!result.ok) return result;
    const clock = getClock(ctx.sandbox);
    // An offset clock's instant alone does not say how far it was shifted, and
    // a caller that advanced it needs to know whether it landed where it meant
    // to. The other two modes have no offset to report, so they carry none.
    const report: { mode: string; now: number; offsetMs?: number } = {
      mode: clock.mode,
      now: clock.now(),
    };
    if (clock.mode === 'offset') {
      report.offsetMs = clock.capture().offsetMs;
    }
    const base =
      result.data !== null && typeof result.data === 'object'
        ? (result.data as Record<string, unknown>)
        : {};
    return {
      ok: true,
      summary: `${result.summary} · clock: ${clock.mode} at ${clock.date().toISOString()}`,
      data: { ...base, clock: report },
    };
  },
} satisfies MethodRecord;
