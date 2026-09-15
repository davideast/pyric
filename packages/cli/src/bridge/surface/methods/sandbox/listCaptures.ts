import { z } from 'zod';
import { runCaptureMethod } from '../../../../serve/rate-capture-service.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox', method: 'listCaptures', sdkOrigin: 'pyric', effect: 'read',
  signature: 'listCaptures()', description: 'List rate captures.',
  args: z.object({}), operation: 'list_rate_captures', example: {},
  async handler(args, ctx) {
    return runCaptureMethod('listCaptures', args, ctx.projectDir);
  },
} satisfies MethodRecord;
