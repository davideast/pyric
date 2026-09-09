/** Report sandbox state in one call. */
import { z } from 'zod';
import { callSandboxTool } from '../context.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({});

export default {
  verb: 'inspect',
  service: 'sandbox',
  object: 'state',
  description:
    'Report the loaded rules, the document census by collection, and the recent requests and denials in one call. Use this first when behavior is unexpected.',
  parameters,
  async handler(_args, ctx) {
    return callSandboxTool(ctx, 'sandbox_inspect', {});
  },
} satisfies OperationRecord;
