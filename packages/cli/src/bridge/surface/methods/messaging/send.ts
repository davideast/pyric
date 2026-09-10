/** Deliver a message as the FCM server would: to a token, a topic, or a condition. */
import { z } from 'zod';
import { BrokerSendError, type BrokerMessage } from 'pyric/messaging/internal';
import { messageArgument, RENAMES, TARGET_FIELDS } from '../../arguments/messaging.js';
import { operationFailure } from '../../context.js';
import { messagingBrokerFor } from '../../service-handles.js';
import type { Args, InvalidArguments, MethodRecord, MethodValidationContext } from '../../method-types.js';

/** The token this method is refused for when it names none it recognizes. */
const UNREGISTERED_HINT = "Call messaging's tokens method to see the tokens the sandbox has registered.";

/** Refuse a message that names none, or more than one, of token/topic/condition. */
function refuseAmbiguousTarget(args: Args, ctx: MethodValidationContext): InvalidArguments | null {
  const message = (args.message ?? {}) as Args;
  const present = TARGET_FIELDS.filter((field) => message[field] !== undefined);
  if (present.length === 1) return null;
  const body =
    present.length === 0
      ? 'message names none of token, topic, or condition.'
      : `message names more than one of token, topic, condition: ${present.join(', ')}.`;
  return ctx.fail(
    body,
    'Pass exactly one of message.token, message.topic, or message.condition.',
    'message',
  );
}

export default {
  tool: 'messaging',
  method: 'send',
  sdkOrigin: 'firebase-admin',
  effect: 'write',
  signature: 'send(message{token?, topic?, condition?, notification?, data?})',
  description:
    'Deliver a message as the FCM server would, to a token, a topic, or a condition, exactly one of the three.',
  args: z.object({ message: messageArgument }),
  operation: 'send_messaging_message',
  renames: RENAMES,
  example: {
    message: {
      topic: 'news',
      notification: { title: 'Update', body: 'New content is ready.' },
    },
  },
  validate: (args, ctx) => refuseAmbiguousTarget(args, ctx),
  async handler(args, ctx) {
    const message = args.message as BrokerMessage;
    const broker = messagingBrokerFor(ctx);
    try {
      const accepted = broker.send(message);
      return {
        ok: true,
        summary: `Sent ${accepted.name}`,
        data: { name: accepted.name, messageId: accepted.messageId, target: accepted.target },
      };
    } catch (error) {
      if (!(error instanceof BrokerSendError)) throw error;
      const hint = error.errorCode === 'UNREGISTERED' ? ` ${UNREGISTERED_HINT}` : '';
      return operationFailure(`${error.envelope.error.message}${hint}`);
    }
  },
} satisfies MethodRecord;
