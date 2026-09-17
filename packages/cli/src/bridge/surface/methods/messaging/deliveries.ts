/** List what was delivered, foreground or background, handled or not. */
import { z } from 'zod';
import { messagingBrokerFor } from '../../service-handles.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'messaging',
  method: 'deliveries',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'deliveries(since?)',
  description:
    'List routing and browser-reported receiver/display acknowledgments by message and recipient. handled means a broker handler ran; display-accepted does not prove OS visibility. Missing receipt remains unconfirmed. Optionally filter by routing timestamp.',
  args: z.object({
    since: z
      .number()
      .optional()
      .describe('Clock timestamp cursor; only deliveries at or after it are returned.'),
  }),
  operation: 'list_messaging_deliveries',
  example: {},
  async handler(args, ctx) {
    const since = args.since === undefined ? undefined : Number(args.since);
    const delivered = messagingBrokerFor(ctx).deliveries(since);
    return {
      ok: true,
      summary: `${delivered.length} deliveries`,
      data: { deliveries: delivered },
    };
  },
} satisfies MethodRecord;
