import { z } from 'zod';
import { runCaptureMethod } from '../../../../serve/rate-capture-service.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox', method: 'openCapture', sdkOrigin: 'pyric', effect: 'read',
  signature: 'openCapture(id?)', description: 'Inspect rate capture.',
  args: z.object({ id: z.string().optional().describe('Capture id. Omit to open the latest saved capture. Read-only; does not restore or replay.') }), operation: 'open_rate_capture', example: {},
  async handler(args, ctx) {
    return runCaptureMethod('openCapture', args, ctx.projectDir);
  },
} satisfies MethodRecord;
