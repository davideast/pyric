import { z } from 'zod';
import { runCaptureMethod } from '../../../../serve/rate-capture-service.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox', method: 'deleteCapture', sdkOrigin: 'pyric', effect: 'destructive',
  signature: 'deleteCapture(id, confirm)', description: 'Delete a capture.',
  args: z.object({ id: z.string(), confirm: z.boolean().describe('Must be true to remove this saved snapshot.') }), operation: 'delete_rate_capture', example: { id: '00000000-0000-4000-8000-000000000000', confirm: true },
  async handler(args, ctx) { return runCaptureMethod('deleteCapture', args, ctx.projectDir); },
} satisfies MethodRecord;
