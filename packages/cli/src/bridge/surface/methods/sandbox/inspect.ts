/** Report what the sandbox holds across Firestore, Database, Storage, and Auth. */
import { z } from 'zod';
import { getClock } from 'pyric/sandbox';
import {
  captureSandboxSnapshot,
  summarizeSandboxSnapshot,
} from 'pyric/sandbox/internal';
import { callSandboxTool } from '../../sandbox-context.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox',
  method: 'inspect',
  runsIn: 'sandbox',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'inspect(includeData?, recentEventLimit?)',
  description: 'Read state.',
  args: z.object({
    includeData: z.boolean().optional(),
    recentEventLimit: z.number().int().positive().optional(),
  }),
  operation: 'inspect_sandbox',
  example: {},
  async handler(args, ctx) {
    const toolArgs: Record<string, unknown> = {};
    if (typeof args.recentEventLimit === 'number') {
      toolArgs.recentEventLimit = args.recentEventLimit;
    }
    const result = await callSandboxTool(ctx, 'sandbox_inspect', toolArgs);
    if (!result.ok) return result;
    const snapshot = await captureSandboxSnapshot(ctx.sandbox, {
      excludePasswords: true,
    });
    const services = summarizeSandboxSnapshot(snapshot, {
      includeData: args.includeData === true,
    });
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
    let base: Record<string, unknown> = {};
    if (result.data !== null && typeof result.data === 'object') {
      base = result.data as Record<string, unknown>;
    }
    const summary =
      `${result.summary}`
      + ` · rtdb: ${services.database.nodeCount} nodes`
      + ` · storage: ${services.storage.totalObjects} objects`
      + ` · auth: ${services.auth.totalUsers} users`
      + ` · clock: ${clock.mode} at ${clock.date().toISOString()}`;
    return {
      ok: true,
      summary,
      data: {
        ...base,
        firestore: services.firestore,
        database: services.database,
        storage: services.storage,
        auth: services.auth,
        clock: report,
      },
    };
  },
} satisfies MethodRecord;
