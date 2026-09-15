import { z } from 'zod';
import { runCaptureMethod } from '../../../../serve/rate-capture-service.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox', method: 'saveCapture', sdkOrigin: 'pyric', effect: 'write',
  signature: 'saveCapture(capture)', description: 'Save rate capture JSON.',
  args: z.object({ capture: z.string().max(32 * 1024 * 1024).describe('JSON from a runtime rate capture, including its measured interval.') }), operation: 'save_rate_capture', example: { capture: "{\"schema\":\"pyric.rate-capture.v1\",\"createdAt\":\"2026-09-15T00:00:00Z\",\"frame\":{\"service\":{\"service\":\"rtdb\",\"coverage\":\"partial\",\"observed\":true,\"untrackedMethods\":[],\"methods\":[]},\"points\":[{\"second\":10,\"reads\":2,\"writes\":4,\"deletes\":0,\"deliveries\":1}],\"to\":10,\"duration\":1,\"clockOffset\":1000,\"totals\":{\"reads\":2,\"writes\":4,\"deletes\":0,\"deliveries\":1},\"peaks\":{\"reads\":2,\"writes\":4,\"deletes\":0,\"deliveries\":1},\"from\":10},\"thresholds\":{}}" },
  async handler(args, ctx) {
    return runCaptureMethod('saveCapture', args, ctx.projectDir);
  },
} satisfies MethodRecord;
