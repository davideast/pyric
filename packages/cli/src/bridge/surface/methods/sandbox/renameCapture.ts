import { z } from 'zod';
import { runCaptureMethod } from '../../../../serve/rate-capture-service.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox', method: 'renameCapture', sdkOrigin: 'pyric', effect: 'write',
  signature: 'renameCapture(id, name)', description: 'Name a capture.',
  args: z.object({ id: z.string(), name: z.string().max(80).describe('Capture name. Empty clears the name.') }), operation: 'rename_rate_capture', example: { id: '00000000-0000-4000-8000-000000000000', name: 'Message burst' },
  async handler(args, ctx) { return runCaptureMethod('renameCapture', args, ctx.projectDir); },
} satisfies MethodRecord;
