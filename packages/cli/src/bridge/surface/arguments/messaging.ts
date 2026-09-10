/**
 * The `messaging` tool's argument vocabulary.
 *
 * `send` nests its payload under `message`, exactly one of `token`, `topic`,
 * or `condition` naming the target, the way the admin SDK's own `Message`
 * union does. A caller that spells the target fields at the top level, the
 * way a raw FCM payload reads, gets pointed at the nested field it meant.
 */
import { z } from 'zod';

export const RENAMES: Readonly<Record<string, string>> = {
  token: 'message.token',
  topic: 'message.topic',
  condition: 'message.condition',
  notification: 'message.notification',
  data: 'message.data',
  registrationToken: 'message.token',
  registrationTokens: 'tokens',
  deviceToken: 'message.token',
  deviceTokens: 'tokens',
};

/** The three ways a message names its recipient. Exactly one is set. */
export const messageArgument = z
  .object({
    token: z.string().optional().describe('A single device registration token.'),
    topic: z.string().optional().describe('A topic name every subscribed token receives.'),
    condition: z
      .string()
      .optional()
      .describe("A boolean expression over topics, for example \"'news' in topics\"."),
    notification: z
      .object({
        title: z.string().optional().describe('Notification title.'),
        body: z.string().optional().describe('Notification body.'),
      })
      .optional()
      .describe('The display notification, when this message carries one.'),
    data: z
      .record(z.string())
      .optional()
      .describe('Data-only payload, delivered to the handler as a flat string map.'),
  })
  .describe('The message to deliver, exactly one of token, topic, or condition.');

export const tokensArgument = z
  .array(z.string())
  .describe('Device registration tokens to subscribe or unsubscribe.');

export const topicArgument = z.string().describe('Topic name, without the /topics/ prefix.');

/** The three target fields, so a validator can check exactly one is set. */
export const TARGET_FIELDS = ['token', 'topic', 'condition'] as const;
