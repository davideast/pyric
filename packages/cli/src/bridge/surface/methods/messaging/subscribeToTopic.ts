/** Subscribe device tokens to a topic. */
import { z } from 'zod';
import { RENAMES, tokensArgument, topicArgument } from '../../arguments/messaging.js';
import { messagingBrokerFor } from '../../service-handles.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'messaging',
  method: 'subscribeToTopic',
  sdkOrigin: 'firebase-admin',
  effect: 'write',
  signature: 'subscribeToTopic(tokens[], topic)',
  description: 'Subscribe device tokens to a topic.',
  args: z.object({ tokens: tokensArgument, topic: topicArgument }),
  operation: 'subscribe_messaging_topic',
  renames: RENAMES,
  example: { tokens: ['device-token-1'], topic: 'news' },
  async handler(args, ctx) {
    const tokens = args.tokens as string[];
    const topic = String(args.topic);
    const broker = messagingBrokerFor(ctx);
    const outcome = broker.subscribeToTopic(tokens, topic);
    return {
      ok: true,
      summary: `Subscribed ${outcome.successCount} of ${tokens.length} tokens to ${topic}`,
      data: outcome,
    };
  },
} satisfies MethodRecord;
