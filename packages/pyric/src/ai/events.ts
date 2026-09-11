/**
 * What the AI surface puts on the sandbox event stream.
 *
 * The broker emits one event per answered call, per rejection, and per
 * substitution. The scripted engine's pending entry queue is not here: a
 * queued entry is a registration waiting to be used, not something that
 * happened, and its matcher and responder are functions no event can carry.
 */
import type { ServiceEventRecord } from '../sandbox/types/service-event-record.js';

export const AI_EVENT_RECORD = {
  service: 'ai',
  operations: [
    'generate_content',
    'stream_generate_content',
    'count_tokens',
    'request_rejected',
    'response_blocked',
    'model_substituted',
  ],
  target: {
    name: 'model',
    description: 'The model name the call named, e.g. gemini-2.5-flash.',
    always: false,
  },
} as const satisfies ServiceEventRecord;

/** Every operation the AI surface emits. */
export type AiEventOperation = (typeof AI_EVENT_RECORD)['operations'][number];
