/** List the runs `fire` caused: cause, duration, and result or error. */
import { z } from 'zod';
import { executionLogFor } from '../../../../functions-rtdb/execution-log.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'functions',
  method: 'executions',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'executions(since?)',
  description:
    'Runs that fired through fire, with their cause, duration, and result or error, optionally since a clock timestamp cursor.',
  args: z.object({
    since: z
      .number()
      .optional()
      .describe('Clock timestamp cursor; only executions at or after it are returned.'),
  }),
  operation: 'list_functions_executions',
  example: {},
  async handler(args, ctx) {
    const since = args.since === undefined ? undefined : Number(args.since);
    const executions = executionLogFor(ctx.sandbox).list(since);
    return {
      ok: true,
      summary: `${executions.length} execution(s)`,
      data: { executions },
    };
  },
} satisfies MethodRecord;
