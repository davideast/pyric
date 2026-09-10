/** List every registered device token and the topics it is subscribed to. */
import { z } from 'zod';
import { messagingBrokerFor } from '../../service-handles.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'messaging',
  method: 'tokens',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'tokens()',
  description: 'List every registered device token, its state, and the topics it is subscribed to.',
  args: z.object({}),
  operation: 'list_messaging_tokens',
  example: {},
  async handler(_args, ctx) {
    const registered = messagingBrokerFor(ctx).tokens();
    return {
      ok: true,
      summary: `${registered.length} registered tokens`,
      data: { tokens: registered },
    };
  },
} satisfies MethodRecord;
