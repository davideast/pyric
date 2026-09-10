/** Unsubscribe device tokens from a topic. */
import { z } from 'zod';
import { RENAMES, tokensArgument, topicArgument } from '../../arguments/messaging.js';
import { messagingBrokerFor } from '../../service-handles.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'messaging',
  method: 'unsubscribeFromTopic',
  sdkOrigin: 'firebase-admin',
  effect: 'write',
  signature: 'unsubscribeFromTopic(tokens[], topic)',
  description: 'Unsubscribe device tokens from a topic.',
  args: z.object({ tokens: tokensArgument, topic: topicArgument }),
  operation: 'unsubscribe_messaging_topic',
  renames: RENAMES,
  example: { tokens: ['device-token-1'], topic: 'news' },
  async handler(args, ctx) {
    const tokens = args.tokens as string[];
    const topic = String(args.topic);
    const broker = messagingBrokerFor(ctx);
    const outcome = broker.unsubscribeFromTopic(tokens, topic);
    return {
      ok: true,
      summary: `Unsubscribed ${outcome.successCount} of ${tokens.length} tokens from ${topic}`,
      data: outcome,
    };
  },
} satisfies MethodRecord;
