/**
 * What the messaging surface puts on the sandbox event stream.
 *
 * The broker emits one event per token, subscription, and routing decision, so
 * the stream carries the whole delivery history and no private log has to.
 */
import type { ServiceEventRecord } from '../sandbox/types/service-event-record.js';

export const MESSAGING_EVENT_RECORD = {
  service: 'messaging',
  operations: [
    'token_minted',
    'token_deleted',
    'subscription_changed',
    'message_accepted',
    'message_rejected',
    'delivery_routed',
    'message_delivered',
  ],
  target: {
    name: 'token',
    description: 'The registration token a token or subscription operation addressed.',
    always: false,
  },
} as const satisfies ServiceEventRecord;

/** Every operation the messaging surface emits. */
export type MessagingEventOperation = (typeof MESSAGING_EVENT_RECORD)['operations'][number];
